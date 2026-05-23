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

export const abuseOverrideExpirySweep = inngest.createFunction(
  {
    id: "abuse-override-expiry-sweep",
    triggers: [{ cron: "30 3 * * *" }],
  },
  async () => {
    if (process.env.STAGING_MODE === "true") return { skipped_for_staging: true };

    return withPlatformAdminAudit(
      { admin_user_id: "system-cron", reason: "abuse_override_revoke", operation: "abuse_override_expiry_sweep" },
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

        const touchedTenants = new Set<string>();

        for (const r of rows) {
          await db
            .from("tenant_usage_overrides")
            .update({ expiry_notified_at: new Date().toISOString() })
            .eq("id", r.id);
          touchedTenants.add(r.tenant_id);

          // Audit the expiry as a state-transition-like event so admins see
          // it in usage_limit_events history.
          await db.from("usage_limit_events").insert({
            tenant_id: r.tenant_id,
            dimension: r.dimension,
            from_state: "override_active",
            to_state: "override_expired",
            metric_value: "0",
            threshold_crossed: "0",
            resolution_action: `override_expired:${r.id}`,
          });
        }

        // Recompute state for each touched tenant (revert to tier caps).
        for (const tenant_id of touchedTenants) {
          await inngest.send({
            name: "tenant.subscription_changed",
            data: { tenant_id, change: "tier" },
          });
        }

        return {
          expired_overrides: rows.length,
          tenants_recomputed: touchedTenants.size,
        };
      },
    );
  },
);
