// BP34 §34.4 — Daily sweep of the import_queue.
//
// Removes import_queue rows whose `purgable_at <= NOW()`. The pipeline
// sets purgable_at at status transitions per the retention matrix:
//   - parse_failed:                7d
//   - auto_accepted/accepted:     24h
//   - rejected:                   24h
//   - virus_detected:             30d
//   - pending_review:        no purge (until agent acts)
//
// Per §34.4 the source document itself is discarded. In Phase B / early
// Phase C the "document" is just `uploaded_file_path` on import_queue
// (Supabase storage object path) — the row deletion implicitly drops the
// reference. Storage cleanup is a follow-up: a deferred listener on this
// cron will issue storage.remove() once the upload route is live.
//
// Audit: each purge writes an `audit_log` row with action='document.purged'
// per §26.5. Batch-sized at 500 rows per run to keep the audit_log write
// cost predictable.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { writeAuditLog } from "@/lib/audit/write";

const BATCH_LIMIT = 500;

export const purgeParsedDocuments = inngest.createFunction(
  {
    id: "purge-parsed-documents",
    triggers: [{ cron: "0 4 * * *" }], // daily at 04:00 UTC
  },
  async () => {
    if (process.env.STAGING_MODE === "true") {
      const svc = createServiceRoleClient();
      await svc.from("staging_cron_skips").insert({ cron_id: "purge-parsed-documents" });
      return { skipped_for_staging: true };
    }

    const svc = createServiceRoleClient();
    const nowIso = new Date().toISOString();

    const { data: due, error: scanErr } = await svc
      .from("import_queue")
      .select("id, tenant_id, status, source_ref, uploaded_file_path")
      .lte("purgable_at", nowIso)
      .limit(BATCH_LIMIT);

    if (scanErr) {
      console.error("[purge-parsed-documents] scan failed:", scanErr.message);
      return { error: scanErr.message };
    }

    const rows = (due ?? []) as Array<{
      id: string;
      tenant_id: string;
      status: string;
      source_ref: string;
      uploaded_file_path: string | null;
    }>;

    if (rows.length === 0) return { purged: 0 };

    // Storage cleanup goes here when upload route lands. For now we only
    // hard-delete the queue row; orphaned blobs are caught by a separate
    // storage-sweep job (Phase D).

    const ids = rows.map((r) => r.id);
    const { error: delErr } = await svc.from("import_queue").delete().in("id", ids);
    if (delErr) {
      console.error("[purge-parsed-documents] delete failed:", delErr.message);
      return { error: delErr.message };
    }

    for (const row of rows) {
      await writeAuditLog({
        tenant_id: row.tenant_id,
        actor_type: "system",
        action: "document.purged",
        resource_type: "import_queue",
        resource_id: row.id,
        context: {
          status_at_purge: row.status,
          source_ref: row.source_ref,
          had_file: row.uploaded_file_path !== null,
        },
      });
    }

    return { purged: rows.length };
  },
);
