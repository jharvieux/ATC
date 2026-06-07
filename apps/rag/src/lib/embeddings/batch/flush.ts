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
// (~$0.001 each at small volumes) but not silently incorrect — both batches
// resolve into their own pending_embedding row scoped by custom_id, and the
// chunk's embedding column gets written twice (last-writer-wins). Both
// vectors are valid embeddings of the same content, so the order doesn't
// matter for retrieval correctness.

import type { SupabaseClient } from "@supabase/supabase-js";
import { bulkFlipPendingStatus } from "./bulk-flip";
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

// OpenAI Batch API caps each batch at 50,000 requests / 200 MB. We bundle up to
// 2,000 embeddings per flush — comfortably below both ceilings (a 2,000-row
// input is ~1 MB; chunk content averages ~400 bytes), giving ~12,000 chunks/hour
// at the 10-minute cadence so bulk backfills drain quickly. Safe at 2,000 on both
// sides of the round-trip: the flush flips status via bulkFlipPendingStatus
// (chunked .in() — an un-chunked 2,000-id flip exceeds PostgREST's URL limit and
// 500-loops, #805) and the reconciler (#789) applies completed batches via
// bounded-concurrency writes + bulked flips + a per-run row budget. A single
// failed batch re-embeds ≤2,000 rows (~$0.04 — negligible). The Anthropic
// neighbour (apps/main/src/lib/ai/batch/flush.ts) uses 50 because message-batch
// payloads are 10–20× larger per row than embedding inputs.
const MAX_REQUESTS_PER_BATCH = 2_000;

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

  // Pull up to MAX_REQUESTS_PER_BATCH pending rows, FIFO. PostgREST caps any
  // single response at ~1,000 rows (db-max-rows) regardless of .limit(), so page
  // in 1,000-row windows (#788/#808) to assemble a full batch. The rows aren't
  // flipped until below, so offset-based paging over status='pending' is stable.
  const PAGE = 1_000;
  const pending: PendingEmbeddingRow[] = [];
  while (pending.length < MAX_REQUESTS_PER_BATCH) {
    const want = Math.min(PAGE, MAX_REQUESTS_PER_BATCH - pending.length);
    const { data, error } = await db
      .from("pending_embedding")
      .select("id, chunk_id, content, custom_id, status, batch_id, openai_file_id, output_file_id, error_detail, queued_at, submitted_at, completed_at")
      .eq("status", "pending")
      .order("queued_at", { ascending: true })
      .range(pending.length, pending.length + want - 1);
    if (error) {
      throw new Error(`flushPendingEmbeddings: pending lookup failed: ${error.message}`);
    }
    const rows = (data ?? []) as PendingEmbeddingRow[];
    pending.push(...rows);
    if (rows.length < want) break;
  }
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

  // Flip to 'submitted' in ≤200-id chunks. The OpenAI batch is already created
  // above, so an un-chunked .in() with up to 2,000 ids would exceed PostgREST's
  // URL limit, throw, and 500-loop while re-billing batches (#805).
  await bulkFlipPendingStatus(
    db,
    pending.map((p) => p.id),
    {
      status: "submitted",
      batch_id: batchId,
      openai_file_id: fileId,
      submitted_at: new Date().toISOString(),
    },
    "pending_embedding.update.submitted",
  );

  return {
    flushed: pending.length,
    batch_id: batchId,
    openai_file_id: fileId,
    remaining,
  };
}
