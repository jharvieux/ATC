// §26.5a — Daily purge of expired forensics_log rows (90-day default
// retention, set at capture time as purge_after = NOW() + 90d). Rows
// with legal_hold=TRUE are preserved indefinitely.
//
// The dangling audit_log.forensics_log_id reference is intentional —
// audit_log retention (7y per §26.5) is independent.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { writeAuditLog } from "@/lib/audit/write";
import { safeAwait } from "@/lib/db/safe-mutation";

export const forensicsLogPurgeCron = inngest.createFunction(
  {
    id: "forensics-log-purge-cron",
    triggers: [{ cron: "0 3 * * *" }], // daily 03:00 UTC
  },
  async () => {
    const svc = createServiceRoleClient();

    if (process.env.STAGING_MODE === "true") {
      await safeAwait(svc.from("staging_cron_skips").insert({ cron_id: "forensics-log-purge-cron" }), "staging_cron_skips.insert");
      return { skipped_for_staging: true };
    }

    const { count, error } = await svc
      .from("forensics_log")
      .delete({ count: "exact" })
      .lt("purge_after", new Date().toISOString())
      .eq("legal_hold", false);

    if (error) {
      console.error("[forensics-log-purge-cron] delete failed:", error.message);
      return { deleted: 0, error: error.message };
    }

    await writeAuditLog({
      actor_type: "system",
      action: "forensics_retention_purge",
      resource_type: "forensics_log",
      changes: { deleted_count: count ?? 0 },
    });

    return { deleted: count ?? 0 };
  },
);
