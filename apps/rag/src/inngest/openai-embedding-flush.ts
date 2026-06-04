// Issue #686 — Flush pending embedding rows into an OpenAI batch.
//
// Runs every 10 minutes. Bundles up to MAX_REQUESTS_PER_BATCH pending rows
// into a single OpenAI batch (one file upload + one batches.create) and
// returns counts for Inngest observability.
//
// Concurrency limited to 1 so two flushes can never race.
//
// Skipped when OPENAI_EMBEDDING_BATCH_ENABLED is set to "false" — leaves
// pending rows in place so we can recover by flipping the flag back on.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { inngest } from "./client";
import { flushPendingEmbeddings } from "@/lib/embeddings/batch/flush";
import { isEmbeddingBatchEnabled } from "@/lib/embeddings/feature-flag";

function ragDb(): SupabaseClient {
  const url = process.env.SUPABASE_RAG_URL;
  const key = process.env.SUPABASE_RAG_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("RAG Supabase env not set for openai-embedding-flush");
  return createClient(url, key, { auth: { persistSession: false } });
}

export const openaiEmbeddingFlush = inngest.createFunction(
  {
    id: "openai-embedding-flush",
    concurrency: { limit: 1 },
    triggers: [{ cron: "*/10 * * * *" }],
  },
  async () => {
    if (process.env.STAGING_MODE === "true") return { skipped_for_staging: true };
    if (!isEmbeddingBatchEnabled()) return { skipped: "batch_disabled" };

    const db = ragDb();
    const result = await flushPendingEmbeddings({ db });
    return { ok: true, ...result };
  },
);
