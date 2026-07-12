// §27.14 — Override expiry sweep.
//
// Runs daily. Finds overrides whose effective_to is past today AND
// expiry_notified_at IS NULL, notifies tenant admins that the override
// has expired (caps reverted to tier defaults), and stamps
// expiry_notified_at so the next run is a no-op.
//
// Also fires a tenant.subscription_changed-style recompute so the state
// machine picks up the reverted cap immediately.

import { inngest } from "./client";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { mapWithConcurrency } from "@/lib/async/with-concurrency";

// #1789 — up to 1000 expired-override rows per run; bounded concurrency
// caps how many overlapping writes hit the DB at once.
const SWEEP_CONCURRENCY = 20;

export const abuseOverrideExpirySweep = inngest.createFunction(
  {
    id: "abuse-override-expiry-sweep",
    triggers: [{ cron: "30 3 * * *" }],
  },
  async () => {
    if (process.env.STAGING_MODE === "true") return { skipped_for_staging: true };

    return withPlatformAdminAudit(
      {
        admin_user_id: "system-cron",
        reason: "abuse_override_revoke",
        operation: "abuse_override_expiry_sweep",
        reason_detail: "automated_expiry_sweep_revokes_overrides_past_effective_to",
      },
      async (db, recordQuery) => {
        const today = new Date().toISOString().slice(0, 10);
        const { data: expired } = await db
          .from("tenant_usage_overrides")
          .select("id, tenant_id, dimension, effective_to")
          .lt("effective_to", today)
          .is("expiry_notified_at", null)
          .limit(1000);
        const rows = (expired ?? []) as Array<{ id: string; tenant_id: string; dimension: string; effective_to: string }>;
        recordQuery({ op: "select", table: "tenant_usage_overrides", row_count: rows.length });

        // Each override row is independent (distinct id/tenant/dimension) —
        // bounded-concurrency fan out instead of one row at a time.
        const touchedTenants = new Set<string>();
        await mapWithConcurrency(rows, SWEEP_CONCURRENCY, async (r) => {
          await safeAwait(db
            .from("tenant_usage_overrides")
            .update({ expiry_notified_at: new Date().toISOString() })
            .eq("id", r.id), "tenant_usage_overrides.update");
          touchedTenants.add(r.tenant_id);

          // Audit the expiry as a state-transition-like event so admins see
          // it in usage_limit_events history.
          await safeAwait(db.from("usage_limit_events").insert({
            tenant_id: r.tenant_id,
            dimension: r.dimension,
            from_state: "override_active",
            to_state: "override_expired",
            metric_value: "0",
            threshold_crossed: "0",
            resolution_action: `override_expired:${r.id}`,
          }), "usage_limit_events.insert");
        });

        // Recompute state for each touched tenant (revert to tier caps).
        // Independent sends — different tenant_id per event.
        await mapWithConcurrency([...touchedTenants], SWEEP_CONCURRENCY, (tenant_id) =>
          inngest.send({
            name: "tenant.subscription_changed",
            data: { tenant_id, change: "tier" },
          }),
        );

        return {
          expired_overrides: rows.length,
          tenants_recomputed: touchedTenants.size,
        };
      },
    );
  },
);
