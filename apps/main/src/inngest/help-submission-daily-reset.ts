/**
 * BP32 §32.11.2 — help_submission_rate daily reset cron.
 *
 * 00:05 UTC daily. Sets `help_submission_count = 0`,
 * `help_submission_limit_state = 'ok'`,
 * `help_submission_state_changed_at = NULL` on every tenant_usage_metrics
 * row across all tenants.
 *
 * This is the ONLY path back to 'ok' for the help_submission_rate
 * dimension — the state is monotonic-within-day (per MEMORY D-068) and
 * tenants that hit `hard` stay blocked until this cron fires.
 *
 * Why 00:05 UTC: the spec says daily-at-00:00; we run at 00:05 so the
 * previous-day's last few submissions have time to finalize their
 * tenant_usage_metrics writes before we wipe the counters.
 */

import { inngest } from "./client";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";

export const helpSubmissionDailyReset = inngest.createFunction(
  {
    id: "help-submission-daily-reset",
    triggers: [{ cron: "5 0 * * *" }],
  },
  async () => {
    const result = await withPlatformAdminAudit(
      {
        admin_user_id: "system-inngest",
        reason: "abuse_threshold_breach_review",
        operation: "help_submission_daily_reset",
      },
      async (db, recordQuery) => {
        const { data, error } = await db
          .from("tenant_usage_metrics")
          .update({
            help_submission_count: 0,
            help_submission_limit_state: "ok",
            help_submission_state_changed_at: null,
          })
          // Reset everywhere — the daily semantics divergence from the
          // per-billing-period model is documented in MEMORY D-068.
          .gt("help_submission_count", 0)
          .select("tenant_id");
        if (error) throw new Error(`[help-submission-daily-reset] ${error.message}`);
        const rows = (data ?? []) as Array<{ tenant_id: string }>;
        recordQuery({ op: "update", table: "tenant_usage_metrics", row_count: rows.length });
        return { reset_tenants: rows.length };
      },
    );
    return result;
  },
);
