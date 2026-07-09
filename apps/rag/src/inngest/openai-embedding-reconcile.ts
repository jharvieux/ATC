// Issue #686 — Reconcile in-flight OpenAI embedding batches.
//
// Runs every 15 minutes. For each distinct batch_id whose rows are still in
// status='submitted', fetches batch status and (when completed) downloads
// the JSONL output file, updates each chunk's embedding, and flips the
// pending row to 'done'/'failed'.
//
// Idempotent: rows already in status='done' or 'failed' are skipped. Re-
// runs are safe.

import { inngest } from "./client";
import { getRagDb } from "@/lib/db/supabase";
import { reconcileEmbeddingBatches } from "@/lib/embeddings/batch/reconcile";
import { isEmbeddingBatchEnabled } from "@/lib/embeddings/feature-flag";

export const openaiEmbeddingReconcile = inngest.createFunction(
  {
    id: "openai-embedding-reconcile",
    concurrency: { limit: 1 },
    // 15-min cadence (#894 Inngest cost): OpenAI batches complete in
    // minutes-to-hours, so a slower poll only delays embedding writes slightly.
    triggers: [{ cron: "*/15 * * * *" }],
  },
  async () => {
    if (process.env.STAGING_MODE === "true") return { skipped_for_staging: true };
    if (!isEmbeddingBatchEnabled()) return { skipped: "batch_disabled" };

    const db = getRagDb();
    const result = await reconcileEmbeddingBatches({ db });
    return { ok: true, ...result };
  },
);
