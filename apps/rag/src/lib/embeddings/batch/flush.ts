// Issue #686 — Flush pending embedding rows into an OpenAI batch.
//
// 1. Pull oldest N pending rows (FIFO).
// 2. Build JSONL of one /v1/embeddings request per row.
// 3. Upload JSONL via Files API (purpose='batch').
// 4. Create batch with endpoint='/v1/embeddings', completion_window='24h'.
// 5. Stamp batch_id, openai_file_id, submitted_at on each row + flip status='submitted'.
//
// Idempotency: the cron is configured with Inngest concurrency:{limit:1} so
// two flushes can't race. If the cron crashes between step 4 (batch created)
// and step 5 (row update), the same rows remain in 'pending' and the next
// flush will create a second batch with the same content. That's wasteful
// (~$0.001 each at small volumes) but not incorrect — the reconciler dedups
// on chunk_id when it writes embeddings back, so the chunk's embedding will
// be set once even if two batches both compute it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwait } from "@/lib/db/safe-mutation";
import {
  uploadBatchInputFile,
  createEmbeddingBatch,
} from "./openai-client";
import type { BatchInputLine, PendingEmbeddingRow } from "./types";

export interface FlushResult {
  flushed: number;
  batch_id?: string;
  openai_file_id?: string;
  remaining: number;
}

const MAX_REQUESTS_PER_BATCH = 200;

function embeddingModel(): string {
  return process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
}

function embeddingDimensions(): number {
  const raw = process.env.OPENAI_EMBEDDING_DIMENSIONS;
  if (!raw) return 1536;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`OPENAI_EMBEDDING_DIMENSIONS not a positive integer: ${raw}`);
  }
  return n;
}

export async function flushPendingEmbeddings(args: {
  db: SupabaseClient;
}): Promise<FlushResult> {
  const { db } = args;

  const { data, error } = await db
    .from("pending_embedding")
    .select("id, chunk_id, content, custom_id, status, batch_id, openai_file_id, output_file_id, error_detail, queued_at, submitted_at, completed_at")
    .eq("status", "pending")
    .order("queued_at", { ascending: true })
    .limit(MAX_REQUESTS_PER_BATCH);
  if (error) {
    throw new Error(`flushPendingEmbeddings: pending lookup failed: ${error.message}`);
  }
  const pending = (data ?? []) as PendingEmbeddingRow[];
  if (pending.length === 0) {
    return { flushed: 0, remaining: 0 };
  }

  const { count: remainingCount } = await db
    .from("pending_embedding")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");
  const remaining = Math.max(0, (remainingCount ?? 0) - pending.length);

  const model = embeddingModel();
  const dimensions = embeddingDimensions();

  const jsonl = pending
    .map((row) => {
      const line: BatchInputLine = {
        custom_id: row.custom_id,
        method: "POST",
        url: "/v1/embeddings",
        body: { model, input: row.content, dimensions },
      };
      return JSON.stringify(line);
    })
    .join("\n");

  const fileId = await uploadBatchInputFile(jsonl);
  const batchId = await createEmbeddingBatch(fileId);

  await safeAwait(
    db
      .from("pending_embedding")
      .update({
        status: "submitted",
        batch_id: batchId,
        openai_file_id: fileId,
        submitted_at: new Date().toISOString(),
      })
      .in(
        "id",
        pending.map((p) => p.id),
      ),
    "pending_embedding.update.submitted",
  );

  return {
    flushed: pending.length,
    batch_id: batchId,
    openai_file_id: fileId,
    remaining,
  };
}
