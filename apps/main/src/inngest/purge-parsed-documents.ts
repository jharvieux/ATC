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
// Per §34.4 the source document itself is discarded. The Phase C upload
// route writes the PDF to the `imported-documents` storage bucket and
// stores the path on `import_queue.uploaded_file_path`. This cron now
// issues `storage.remove([paths])` BEFORE deleting the queue rows so the
// audit log's `document.purged` action accurately reflects reality.
// Audit pass 2, Finding 7 flagged that prior versions deleted the row
// but left the blob in storage, making the audit row a false signal.
//
// Audit: each purge writes an `audit_log` row with action='document.purged'
// per §26.5. Batch-sized at 500 rows per run to keep the audit_log write
// cost predictable.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { writeAuditLog } from "@/lib/audit/write";
import { safeAwait } from "@/lib/db/safe-mutation";
import { mapWithConcurrency } from "@/lib/async/with-concurrency";

const BATCH_LIMIT = 500;
// #1789 — audit-log writes for already-deleted rows are independent inserts.
const AUDIT_CONCURRENCY = 20;

export const purgeParsedDocuments = inngest.createFunction(
  {
    id: "purge-parsed-documents",
    triggers: [{ cron: "0 4 * * *" }], // daily at 04:00 UTC
  },
  async () => {
    if (process.env.STAGING_MODE === "true") {
      const svc = createServiceRoleClient();
      await safeAwait(svc.from("staging_cron_skips").insert({ cron_id: "purge-parsed-documents" }), "staging_cron_skips.insert");
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

    // Storage cleanup. Drop the blob BEFORE the row so the audit log's
    // `document.purged` action accurately reflects what was removed. If
    // storage.remove() fails, leave the row in place and re-queue on the
    // next run (purgable_at is unchanged, so the row will reappear).
    const paths = rows
      .map((r) => r.uploaded_file_path)
      .filter((p): p is string => p !== null && p.length > 0);

    if (paths.length > 0) {
      const { error: storageErr } = await svc.storage
        .from("imported-documents")
        .remove(paths);
      if (storageErr) {
        // Don't proceed with the row delete — the next cron run will retry.
        // Better to leak rows for a day than to leak blobs forever.
        console.error(
          "[purge-parsed-documents] storage.remove failed: %s; will retry next run",
          storageErr.message,
        );
        return { error: `storage_remove_failed: ${storageErr.message}` };
      }
    }

    const ids = rows.map((r) => r.id);
    const { error: delErr } = await svc.from("import_queue").delete().in("id", ids);
    if (delErr) {
      console.error("[purge-parsed-documents] delete failed:", delErr.message);
      return { error: delErr.message };
    }

    await mapWithConcurrency(rows, AUDIT_CONCURRENCY, (row) =>
      writeAuditLog({
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
      }),
    );

    return { purged: rows.length };
  },
);
