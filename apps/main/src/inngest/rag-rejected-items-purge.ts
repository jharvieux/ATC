// §25.2 — Weekly purge of rejected RAG submissions older than 90 days.
//
// rag_submissions lives on the main-app side (per BP22). Reject decisions
// are made by tenant admins; after 90 days the row is no longer useful
// for moderation transparency.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";

export const ragRejectedItemsPurge = inngest.createFunction(
  {
    id: "rag-rejected-items-purge",
    triggers: [{ cron: "0 6 * * 0" }], // Sunday 06:00 UTC
  },
  async () => {
    const svc = createServiceRoleClient();

    if (process.env.STAGING_MODE === "true") {
      await safeAwait(svc.from("staging_cron_skips").insert({
        cron_id: "rag-rejected-items-purge",
      }), "staging_cron_skips.insert");
      return { skipped_for_staging: true };
    }

    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await svc
      .from("rag_submissions")
      .delete({ count: "exact" })
      .eq("review_status", "rejected")
      .lt("tenant_review_decision_at", cutoff);

    if (error) {
      console.error("[rag-rejected-items-purge] delete failed:", error.message);
      return { deleted: 0, error: error.message };
    }
    return { deleted: count ?? 0 };
  },
);
