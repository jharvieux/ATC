// §17.10 — Daily cron: alerts operator when staging hasn't been refreshed for 25 days.
// The staging refresh naturally propagates CCPA deletions from production.
// If it hasn't run in 25 days, the operator must manually apply staging-fixups.sql.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";

export const ccpaStagingPropagationMonitor = inngest.createFunction(
  {
    id: "ccpa-staging-propagation-monitor",
    triggers: [{ cron: "0 6 * * *" }],
  },
  async () => {
    const db = createServiceRoleClient();

    const { data: setting, error } = await db
      .from("platform_settings")
      .select("value")
      .eq("key", "last_staging_refresh_at")
      .maybeSingle();

    if (error) {
      console.error("[ccpa-staging-monitor] failed to read platform_settings: %s", error.message);
      return;
    }

    if (!setting) {
      // No record yet — staging pipeline hasn't run. Alert if any deleted users exist.
      const { count } = await db
        .from("users")
        .select("*", { count: "exact", head: true })
        .not("deleted_at", "is", null);

      if ((count ?? 0) > 0) {
        console.warn(
          "[ccpa-staging-monitor] ALERT: %d user(s) have pending CCPA deletions but last_staging_refresh_at is not set. " +
          "Apply scripts/staging-fixups.sql manually. See docs/runbooks/ccpa-staging-cleanup.md.",
          count,
        );
      }
      return;
    }

    const lastRefresh = new Date((setting as { value: string }).value).getTime();
    const daysSinceRefresh = (Date.now() - lastRefresh) / (1000 * 60 * 60 * 24);

    if (daysSinceRefresh >= 25) {
      // Check whether any users are in the deletion window.
      const { count } = await db
        .from("users")
        .select("*", { count: "exact", head: true })
        .not("deleted_at", "is", null);

      await sendOperatorAlert({
        severity: "high",
        signal: "ccpa_staging_refresh_overdue",
        detail:
          `Staging last refreshed ${daysSinceRefresh.toFixed(1)} days ago (threshold 25d). ` +
          `${count ?? 0} user(s) with pending CCPA deletions may not be propagated to staging. ` +
          `See docs/runbooks/ccpa-staging-cleanup.md for manual remediation.`,
        payload: {
          days_since_refresh: Math.round(daysSinceRefresh * 10) / 10,
          pending_deletion_count: count ?? 0,
          threshold_days: 25,
        },
      });
    }
  },
);
