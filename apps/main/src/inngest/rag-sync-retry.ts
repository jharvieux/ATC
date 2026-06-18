// §8.7a — Daily cleanup of delivered RAG tenant-event rows.
//
// The 15-min retry cron (ragSyncRetry) moved to a Vercel cron (#894);
// see @/lib/cron/rag-sync-retry. This daily cleanup stays on Inngest.
//
// Service-role import permitted: background job running outside any user
// session. This file is in the no-direct-service-role-import allowlist.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { inngest } from "./client";

export const ragSyncCleanup = inngest.createFunction(
  { id: "pending-rag-sync-cleanup", triggers: [{ cron: "0 4 * * *" }] },
  async () => {
    const db = createServiceRoleClient();
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { error, count } = await db
      .from("pending_rag_sync")
      .delete({ count: "exact" })
      .not("delivered_at", "is", null)
      .lt("delivered_at", cutoff);

    if (error) {
      console.error("[rag-sync-cleanup] delete failed:", error.message);
      throw error;
    }

    console.log("[rag-sync-cleanup] deleted", count, "rows");
    return { deleted: count };
  },
);
