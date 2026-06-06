// Issue #686 — Reconcile in-flight OpenAI embedding batches.
//
// For each distinct batch_id with at least one row in status='submitted':
//   1. Fetch batch status from OpenAI.
//   2. If still in_progress / validating / finalizing — no-op for that batch.
//   3. If completed — download the output file (JSONL), parse one line per row,
//      look up the matching pending_embedding row by custom_id, and:
//        a. On 200: write the embedding to knowledge_chunks, flip the row done.
//        b. On non-200 / error: flip the row failed with error_detail.
//   4. If failed / expired / cancelled — flip every row for that batch to
//      status='failed' with error_detail derived from batch.errors.
//
// #789 — sized for 2,000-row batches: the output is parsed in a SINGLE pass,
// embeddings are written in bounded-concurrency waves (not 2,000 sequential
// round-trips), status flips are bulked per outcome, cost is aggregated per
// (tenant, model), and a per-run row budget caps how much one invocation does
// so it can't exceed the function timeout when several big batches complete at
// once. A bad output line still fails only its own row.

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwait } from "@/lib/db/safe-mutation";
import { logEmbeddingCall } from "@/lib/embeddings/cost-log";
import { downloadBatchOutput, getBatchStatus } from "./openai-client";
import type { BatchOutputLine, OpenAIBatchSummary } from "./types";

export interface ReconcileResult {
  batches_polled: number;
  batches_completed: number;
  rows_succeeded: number;
  rows_failed: number;
}

const MAX_BATCHES_PER_RUN = 20;
// Embedding writes per concurrency wave. Bounds simultaneous PostgREST requests
// while draining a 2,000-row batch in ~tens of waves rather than 2,000 serial
// round-trips.
const EMBED_WRITE_CONCURRENCY = 25;
// Cap total rows applied per invocation. With 2,000-row batches, a run where
// several complete at once would otherwise apply tens of thousands of rows and
// risk the function timeout; the remainder stays 'submitted' and is picked up
// on the next (5-minute) reconcile.
const MAX_ROWS_PER_RUN = 4_000;
// Chunk the bulk-flip `.in()` id list so the PostgREST query string stays well
// under URL-length limits even when a 2,000-row batch flips status at once.
const STATUS_FLIP_CHUNK = 200;

interface PendingMatch {
  id: string;
  chunk_id: string;
  custom_id: string;
  tenant_id: string | null;
}

export async function reconcileEmbeddingBatches(args: {
  db: SupabaseClient;
}): Promise<ReconcileResult> {
  const { db } = args;
  const result: ReconcileResult = {
    batches_polled: 0,
    batches_completed: 0,
    rows_succeeded: 0,
    rows_failed: 0,
  };

  // Pick up distinct submitted batch_ids, oldest first.
  const { data: batchIdRows, error: lookupErr } = await db
    .from("pending_embedding")
    .select("batch_id, submitted_at")
    .eq("status", "submitted")
    .not("batch_id", "is", null)
    .order("submitted_at", { ascending: true })
    .limit(1000);
  if (lookupErr) {
    throw new Error(`reconcileEmbeddingBatches: lookup failed: ${lookupErr.message}`);
  }

  const distinctBatchIds: string[] = [];
  const seen = new Set<string>();
  for (const row of (batchIdRows ?? []) as Array<{ batch_id: string | null }>) {
    if (row.batch_id && !seen.has(row.batch_id)) {
      seen.add(row.batch_id);
      distinctBatchIds.push(row.batch_id);
      if (distinctBatchIds.length >= MAX_BATCHES_PER_RUN) break;
    }
  }
  if (distinctBatchIds.length === 0) {
    return result;
  }

  let rowsThisRun = 0;
  for (const batchId of distinctBatchIds) {
    result.batches_polled++;
    const status = await getBatchStatus(batchId);

    // `cancelling` is transient — the batch may still emit results. Wait for the
    // terminal `cancelled` status before flipping rows to failed.
    if (
      status.status === "validating" ||
      status.status === "in_progress" ||
      status.status === "finalizing" ||
      status.status === "cancelling"
    ) {
      continue;
    }

    if (status.status === "completed") {
      if (!status.output_file_id) {
        // Completed but no output file — defensive: mark every row failed.
        const failedRows = await failBatch(db, batchId, "completed_without_output_file");
        result.rows_failed += failedRows;
        result.batches_completed++;
        continue;
      }
      const outcome = await applyCompletedBatch({ db, batchId, status });
      result.rows_succeeded += outcome.rows_succeeded;
      result.rows_failed += outcome.rows_failed;
      result.batches_completed++;
      rowsThisRun += outcome.rows_succeeded + outcome.rows_failed;
      // Stop pulling more batches once the per-run budget is spent; the rest
      // stay 'submitted' and reconcile on the next run.
      if (rowsThisRun >= MAX_ROWS_PER_RUN) break;
      continue;
    }

    // failed / expired / cancelled — terminal failures with no output to apply.
    const detail = status.errors?.data?.[0]?.message ?? `batch_${status.status}`;
    const failedRows = await failBatch(db, batchId, detail);
    result.rows_failed += failedRows;
    result.batches_completed++;
  }

  return result;
}

async function applyCompletedBatch(args: {
  db: SupabaseClient;
  batchId: string;
  status: OpenAIBatchSummary;
}): Promise<{ rows_succeeded: number; rows_failed: number }> {
  const { db, batchId, status } = args;

  const { data: pendingData, error: pendingErr } = await db
    .from("pending_embedding")
    .select("id, chunk_id, custom_id, tenant_id")
    .eq("batch_id", batchId)
    .eq("status", "submitted");
  if (pendingErr) {
    throw new Error(
      `applyCompletedBatch: pending lookup failed for ${batchId}: ${pendingErr.message}`,
    );
  }
  const byCustomId = new Map<string, PendingMatch>();
  for (const r of (pendingData ?? []) as PendingMatch[]) {
    byCustomId.set(r.custom_id, r);
  }

  const jsonl = await downloadBatchOutput(status.output_file_id!);
  const completedAt = new Date().toISOString();

  // Single pass: classify each output line into a success or failure work item.
  // (Previously the lines were parsed twice — once here, once to build the
  // "seen" set — which doubled memory at 2,000 rows.)
  const successes: Array<{
    pendingId: string;
    chunkId: string;
    vec: string;
    tenantId: string | null;
    model: string;
    tokens: number;
  }> = [];
  const failures: Array<{ pendingId: string; detail: string }> = [];
  const seenCustomIds = new Set<string>();

  for (const raw of jsonl.split("\n")) {
    if (raw.trim().length === 0) continue;
    let parsed: BatchOutputLine;
    try {
      parsed = JSON.parse(raw) as BatchOutputLine;
    } catch (err) {
      console.warn(`[batch:reconcile] failed to parse line: ${(err as Error).message}`);
      continue;
    }
    const pending = byCustomId.get(parsed.custom_id);
    if (!pending) {
      console.warn(
        `[batch:reconcile] unknown custom_id from OpenAI batch ${batchId}: ${parsed.custom_id}`,
      );
      continue;
    }
    seenCustomIds.add(parsed.custom_id);

    const status_code = parsed.response?.status_code;
    const embedding = parsed.response?.body?.data?.[0]?.embedding;
    if (status_code === 200 && Array.isArray(embedding) && embedding.length > 0) {
      successes.push({
        pendingId: pending.id,
        chunkId: pending.chunk_id,
        vec: `[${embedding.join(",")}]`,
        tenantId: pending.tenant_id ?? null,
        model: parsed.response?.body?.model ?? "text-embedding-3-small",
        tokens: parsed.response?.body?.usage?.prompt_tokens ?? 0,
      });
    } else {
      failures.push({
        pendingId: pending.id,
        detail:
          parsed.error?.message ??
          `non_200_response: status_code=${status_code ?? "null"}`,
      });
    }
  }

  // Any row whose custom_id never appeared in the output is a failure too.
  for (const [customId, pending] of byCustomId) {
    if (!seenCustomIds.has(customId)) {
      failures.push({ pendingId: pending.id, detail: "no_output_line_for_custom_id" });
    }
  }

  // Write embeddings in bounded-concurrency waves. A write error throws and
  // aborts before any status flip — the rows stay 'submitted' and the next run
  // re-applies the same vectors idempotently (so no row is flipped 'done'
  // without its embedding having landed).
  for (let i = 0; i < successes.length; i += EMBED_WRITE_CONCURRENCY) {
    await Promise.all(
      successes.slice(i, i + EMBED_WRITE_CONCURRENCY).map((s) =>
        safeAwait(
          db.from("knowledge_chunks").update({ embedding: s.vec }).eq("id", s.chunkId),
          "knowledge_chunks.update.embedding_from_batch",
        ),
      ),
    );
  }

  // Bulk-flip statuses: chunked UPDATE … .in(id, …) for all successes, and one
  // group per distinct failure reason — instead of one round-trip per row.
  if (successes.length > 0) {
    await bulkFlipStatus(
      db,
      successes.map((s) => s.pendingId),
      { status: "done", output_file_id: status.output_file_id, completed_at: completedAt },
      "pending_embedding.update.done_bulk",
    );
  }
  const failureIdsByDetail = new Map<string, string[]>();
  for (const f of failures) {
    const ids = failureIdsByDetail.get(f.detail) ?? [];
    ids.push(f.pendingId);
    failureIdsByDetail.set(f.detail, ids);
  }
  for (const [detail, ids] of failureIdsByDetail) {
    await bulkFlipStatus(
      db,
      ids,
      { status: "failed", output_file_id: status.output_file_id, error_detail: detail, completed_at: completedAt },
      "pending_embedding.update.failed_bulk",
    );
  }

  // Aggregate cost per (tenant, model) so a 2,000-row batch writes a handful of
  // rag_ai_call_log rows, not 2,000. Best-effort: a cost-log failure must not
  // poison the batch — the embeddings are already persisted at this point.
  const costByKey = new Map<string, { tenant_id: string | null; model: string; tokens: number }>();
  for (const s of successes) {
    const key = `${s.tenantId ?? "∅"}|${s.model}`;
    const entry = costByKey.get(key) ?? { tenant_id: s.tenantId, model: s.model, tokens: 0 };
    entry.tokens += s.tokens;
    costByKey.set(key, entry);
  }
  for (const c of costByKey.values()) {
    try {
      await logEmbeddingCall({ db, tenant_id: c.tenant_id, model: c.model, source: "batch", input_tokens: c.tokens });
    } catch (err) {
      console.warn(
        `[batch:reconcile] cost log failed for ${c.tenant_id ?? "platform"}/${c.model}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return { rows_succeeded: successes.length, rows_failed: failures.length };
}

// Apply a status flip to many pending_embedding rows by id, chunking the .in()
// list so the query string can't exceed PostgREST's URL limit at 2,000 rows.
async function bulkFlipStatus(
  db: SupabaseClient,
  ids: string[],
  payload: Record<string, unknown>,
  context: string,
): Promise<void> {
  for (let i = 0; i < ids.length; i += STATUS_FLIP_CHUNK) {
    await safeAwait(
      db.from("pending_embedding").update(payload).in("id", ids.slice(i, i + STATUS_FLIP_CHUNK)),
      context,
    );
  }
}

// Flip every still-submitted row for `batchId` to failed and return the count
// actually affected (read from .select("id") on the same statement — avoids the
// TOCTOU window of count-then-update).
async function failBatch(
  db: SupabaseClient,
  batchId: string,
  detail: string,
): Promise<number> {
  const rows = await safeAwait(
    db
      .from("pending_embedding")
      .update({
        status: "failed",
        error_detail: detail,
        completed_at: new Date().toISOString(),
      })
      .eq("batch_id", batchId)
      .eq("status", "submitted")
      .select("id"),
    "pending_embedding.update.batch_failed",
  );
  return Array.isArray(rows) ? rows.length : 0;
}
