// §27.7 — Billing-period rollover.
//
// On the 1st of each month UTC, create a fresh tenant_usage_metrics row
// (state='ok', counters=0) for every active tenant for the new period.
// Counters naturally upsert on first event, but this pre-creation lets
// the platform admin dashboard show "current period: ok" from day 1 and
// emits a rollover audit event so we can see resets in usage_limit_events.

import { inngest } from "./client";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { excludeNonPayingPastGrace } from "@/lib/billing/exclude-non-paying";
import { safeAwait, SupabaseMutationError } from "@/lib/db/safe-mutation";
import { mapWithConcurrency } from "@/lib/async/with-concurrency";

// #1789 — up to 5000 tenants per monthly run; bounded concurrency turns a
// worst-case 25,000 sequential round-trips (upsert + 4 audit inserts per
// tenant) into ~5000/20 batches.
const ROLLOVER_CONCURRENCY = 20;
const USAGE_DIMENSIONS = ["ai_cost", "chat_volume", "email_volume", "group_invite"] as const;

function newPeriodRange(): string {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return `[${start},${end})`;
}

export const billingPeriodRollover = inngest.createFunction(
  {
    id: "billing-period-rollover",
    triggers: [{ cron: "5 0 1 * *" }],
  },
  async () => {
    if (process.env.STAGING_MODE === "true") {
      return { skipped_for_staging: true };
    }
    return withPlatformAdminAudit(
      {
        admin_user_id: "system-cron",
        reason: "cross_tenant_admin",
        operation: "billing_period_rollover",
      },
      async (db, recordQuery) => {
        const period = newPeriodRange();
        recordQuery({ op: "select", table: "tenants" });
        const { data: tenantsRaw } = await db
          .from("tenants")
          .select("id, status, subscription_status, non_paying_since, is_platform_internal")
          .in("status", ["active", "sandbox"])
          .limit(5000);

        // §15.16 — past-grace tenants don't need a fresh period row; the
        // counter UPSERT pattern creates rows lazily on first event, and
        // they shouldn't be generating events. #699 internal tenants are
        // exempt and pass through (Booking still uses period rollovers
        // for usage tracking even though it doesn't pay).
        let skippedNonPaying = 0;
        const tenants = excludeNonPayingPastGrace(
          (tenantsRaw ?? []) as Array<{
            id: string;
            status: string;
            subscription_status: string | null;
            non_paying_since: string | null;
            is_platform_internal?: boolean;
          }>,
          () => { skippedNonPaying++; },
        );

        // Each tenant's rollover (upsert + 4 dimension audit inserts) is
        // independent of every other tenant's — bounded-concurrency fan out
        // instead of one tenant at a time.
        const perTenant = await mapWithConcurrency(tenants, ROLLOVER_CONCURRENCY, async (t) => {
          // INSERT … ON CONFLICT DO NOTHING via upsert + ignoreDuplicates.
          const { error: upsertErr } = await db
            .from("tenant_usage_metrics")
            .upsert(
              {
                tenant_id: t.id,
                billing_period: period,
                ai_cost_cents: 0,
                chat_messages_count: 0,
                email_sent_count: 0,
                group_invitees_count: 0,
                ai_cost_limit_state: "ok",
                chat_volume_limit_state: "ok",
                email_volume_limit_state: "ok",
                group_invite_limit_state: "ok",
              },
              { onConflict: "tenant_id,billing_period", ignoreDuplicates: true },
            );

          // Audit rollover for each dimension (any monotonic resets are
          // visible in the events table). The 4 dimensions are independent
          // rows — fan out within the tenant too.
          //
          // D-091 #24 / #23 (#1901) — like the counter upsert above, these
          // audit inserts must be idempotent across Inngest retries and
          // duplicate cron fires. A deterministic resolution_action key
          // (tenant + period + dimension) backed by a partial unique index
          // (usage_limit_events_rollover_uidx, scoped to 'rollover:%') makes
          // the DB reject a re-insert with 23505, which we treat as "already
          // recorded" — so a run that retried N times still leaves exactly 4
          // rollover audit rows per tenant, not 4N.
          await Promise.all(
            USAGE_DIMENSIONS.map(async (dim) => {
              try {
                await safeAwait(db.from("usage_limit_events").insert({
                  tenant_id: t.id,
                  dimension: dim,
                  from_state: "rollover",
                  to_state: "ok",
                  metric_value: "0",
                  threshold_crossed: "0",
                  resolution_action: `rollover:${t.id}:${period}:${dim}`,
                }), "usage_limit_events.insert");
              } catch (err) {
                if (!(err instanceof SupabaseMutationError) || err.code !== "23505") throw err;
              }
            }),
          );

          return { created: !upsertErr };
        });
        const createdRows = perTenant.filter((r) => r.created).length;
        const rolloverEvents = tenants.length * USAGE_DIMENSIONS.length;

        recordQuery({ op: "insert", table: "tenant_usage_metrics", row_count: createdRows });
        recordQuery({ op: "insert", table: "usage_limit_events", row_count: rolloverEvents });
        return {
          new_period: period,
          tenants_seeded: createdRows,
          tenants_skipped_non_paying: skippedNonPaying,
          rollover_events: rolloverEvents,
        };
      },
    );
  },
);
