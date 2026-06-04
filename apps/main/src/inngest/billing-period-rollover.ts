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
import { safeAwait } from "@/lib/db/safe-mutation";

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

        let createdRows = 0;
        let rolloverEvents = 0;
        for (const t of tenants) {
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
          if (!upsertErr) createdRows++;

          // Audit rollover for each dimension (any monotonic resets are visible
          // in the events table).
          for (const dim of ["ai_cost", "chat_volume", "email_volume", "group_invite"]) {
            await safeAwait(db.from("usage_limit_events").insert({
              tenant_id: t.id,
              dimension: dim,
              from_state: "rollover",
              to_state: "ok",
              metric_value: "0",
              threshold_crossed: "0",
            }), "usage_limit_events.insert");
            rolloverEvents++;
          }
        }

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
