/**
 * BP31 §32.3.3 — help_doc_versions purge cron.
 *
 * Daily 03:30 UTC. Deletes help_doc_versions rows whose `expires_at` is
 * more than 7 days in the past. Storage objects in `help-docs/` are also
 * removed best-effort.
 *
 * Operates cross-tenant — runs via withPlatformAdminAudit using the
 * existing reason `help_doc_publishing` (closest existing reason; could
 * be tightened to a dedicated `help_doc_cache_purge` reason later if
 * audit forensics need finer slicing).
 */

import { inngest } from "./client";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";

export const helpDocVersionsPurge = inngest.createFunction(
  {
    id: "help-doc-versions-purge",
    triggers: [{ cron: "30 3 * * *" }],
  },
  async () => {
    const cutoffIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const result = await withPlatformAdminAudit(
      { admin_user_id: "system-inngest", reason: "help_doc_publishing", operation: "help_doc_versions_purge" },
      async (db, recordQuery) => {
        const { data: stale } = await db
          .from("help_doc_versions")
          .select("id, storage_path")
          .lt("expires_at", cutoffIso)
          .limit(500);
        const rows = (stale ?? []) as Array<{ id: string; storage_path: string }>;
        recordQuery({ op: "select", table: "help_doc_versions", row_count: rows.length });

        if (rows.length === 0) return { deleted: 0 };

        // Best-effort storage cleanup. Failures are logged; the row delete
        // still proceeds so we don't accumulate phantom cache entries.
        const paths = rows.map((r) => r.storage_path).filter((p) => p && p.length > 0);
        if (paths.length > 0) {
          const { error: rmErr } = await db.storage.from("help-docs").remove(paths);
          if (rmErr) {
            console.warn(`[help-doc-versions-purge] storage cleanup partial failure: ${rmErr.message}`);
          }
        }

        const ids = rows.map((r) => r.id);
        const { error: delErr } = await db.from("help_doc_versions").delete().in("id", ids);
        if (delErr) throw new Error(delErr.message);
        recordQuery({ op: "delete", table: "help_doc_versions", row_count: ids.length });
        return { deleted: ids.length };
      },
    );

    return result;
  },
);
