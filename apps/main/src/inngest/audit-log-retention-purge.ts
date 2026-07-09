// §26.5 — Daily purge of audit_log rows older than the retention window
// (7 years by default per §26.5; configurable via AUDIT_LOG_RETENTION_DAYS).
//
// audit_log is the canonical, immutable record of platform actions. The
// 7-year boundary aligns with SOC 2 and IRS records-retention norms.
// Rows in the retention window are append-only and never updated; only
// the purge cron deletes, and it writes a meta-audit row recording the
// purge itself (so the retention sweep is auditable).
//
// Companion to:
//   - forensics-log-purge-cron.ts (90-day forensics retention)
//   - rag-rejected-items-purge.ts
//   - help-doc-versions-purge.ts
// All follow the same Inngest cron shape and STAGING_MODE skip.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { writeAuditLog } from "@/lib/audit/write";
import { safeAwait } from "@/lib/db/safe-mutation";
import { env } from "@/lib/env";

export const auditLogRetentionPurge = inngest.createFunction(
  {
    id: "audit-log-retention-purge",
    triggers: [{ cron: "0 4 * * *" }], // daily 04:00 UTC — after forensics purge
  },
  async () => {
    const svc = createServiceRoleClient();

    if (process.env.STAGING_MODE === "true") {
      await safeAwait(svc.from("staging_cron_skips").insert({ cron_id: "audit-log-retention-purge" }), "staging_cron_skips.insert");
      return { skipped_for_staging: true };
    }

    const days = env().AUDIT_LOG_RETENTION_DAYS;
    const cutoffIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { count, error } = await svc
      .from("audit_log")
      .delete({ count: "exact" })
      .lt("occurred_at", cutoffIso);

    if (error) {
      console.error("[audit-log-retention-purge] delete failed:", error.message);
      // Still write the audit row so the failure is visible.
      await writeAuditLog({
        actor_type: "system",
        action: "audit_log_retention_purge_failed",
        resource_type: "audit_log",
        changes: { error: error.message, cutoff: cutoffIso, retention_days: days },
      });
      return { deleted: 0, error: error.message };
    }

    await writeAuditLog({
      actor_type: "system",
      action: "audit_log_retention_purge",
      resource_type: "audit_log",
      changes: { deleted_count: count ?? 0, cutoff: cutoffIso, retention_days: days },
    });

    return { deleted: count ?? 0, cutoff: cutoffIso };
  },
);
