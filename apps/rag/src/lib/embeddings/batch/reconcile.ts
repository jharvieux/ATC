// Issue #686 — Reconcile in-flight OpenAI embedding batches.
//
// For each distinct batch_id with at least one row in status='submitted':
//   1. Fetch batch status from OpenAI.
//   2. If still in_progress / validating / finalizing — no-op for that batch.
//   3. If completed — download the output file (JSONL), parse one line per
//      row, look up the matching pending_embedding row by custom_id, and:
//        a. On 200: UPDATE knowledge_chunks SET embedding = ... WHERE id = chunk_id,
//           then flip pending_embedding row to status='done'.
//        b. On non-200 / error: flip row to status='failed' with error_detail.
//   4. If failed / expired / cancelled — flip every row for that batch to
//      status='failed' with error_detail derived from batch.errors.
//
// Each chunk's embedding update is independent — a per-row failure does not
// abort the rest of the batch.

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwait } from "@/lib/db/safe-mutation";
import { downloadBatchOutput, getBatchStatus } from "./openai-client";
import type {
  BatchOutputLine,
  OpenAIBatchSummary,
  PendingEmbeddingRow,
} from "./types";

export interface ReconcileResult {
  batches_polled: number;
  batches_completed: number;
  rows_succeeded: number;
  rows_failed: number;
}

const MAX_BATCHES_PER_RUN = 20;

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

  for (const batchId of distinctBatchIds) {
    result.batches_polled++;
    const status = await getBatchStatus(batchId);

    if (
      status.status === "validating" ||
      status.status === "in_progress" ||
      status.status === "finalizing"
    ) {
      continue;
    }

    if (status.status === "completed") {
      if (!status.output_file_id) {
        // Completed but no output file — defensive: mark every row failed.
        await failBatch(db, batchId, "completed_without_output_file");
        result.rows_failed += await countSubmittedForBatch(db, batchId);
        result.batches_completed++;
        continue;
      }
      const outcome = await applyCompletedBatch({ db, batchId, status });
      result.rows_succeeded += outcome.rows_succeeded;
      result.rows_failed += outcome.rows_failed;
      result.batches_completed++;
      continue;
    }

    // failed / expired / cancelled / cancelling
    const detail =
      status.errors?.data?.[0]?.message ?? `batch_${status.status}`;
    const failed = await countSubmittedForBatch(db, batchId);
    await failBatch(db, batchId, detail);
    result.rows_failed += failed;
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
    .select("id, chunk_id, custom_id")
    .eq("batch_id", batchId)
    .eq("status", "submitted");
  if (pendingErr) {
    throw new Error(
      `applyCompletedBatch: pending lookup failed for ${batchId}: ${pendingErr.message}`,
    );
  }
  const byCustomId = new Map<
    string,
    Pick<PendingEmbeddingRow, "id" | "chunk_id" | "custom_id">
  >();
  for (const r of (pendingData ?? []) as Array<{
    id: string;
    chunk_id: string;
    custom_id: string;
  }>) {
    byCustomId.set(r.custom_id, r);
  }

  const jsonl = await downloadBatchOutput(status.output_file_id!);
  const lines = jsonl.split("\n").filter((line) => line.trim().length > 0);

  // Update each row's chunk + flip status. We persist output_file_id once
  // for forensics — rather than per-row, persist via a single UPDATE at the
  // end keyed by batch_id (cheaper than N round-trips for that one field).
  let rows_succeeded = 0;
  let rows_failed = 0;
  const completedAt = new Date().toISOString();

  for (const raw of lines) {
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

    const status_code = parsed.response?.status_code;
    const embedding = parsed.response?.body?.data?.[0]?.embedding;
    if (status_code === 200 && Array.isArray(embedding) && embedding.length > 0) {
      // Write embedding to the chunk. pgvector text-literal form.
      const vec = `[${embedding.join(",")}]`;
      await safeAwait(
        db
          .from("knowledge_chunks")
          .update({ embedding: vec })
          .eq("id", pending.chunk_id),
        "knowledge_chunks.update.embedding_from_batch",
      );
      await safeAwait(
        db
          .from("pending_embedding")
          .update({
            status: "done",
            output_file_id: status.output_file_id,
            completed_at: completedAt,
          })
          .eq("id", pending.id),
        "pending_embedding.update.done",
      );
      rows_succeeded++;
    } else {
      const detail =
        parsed.error?.message ??
        `non_200_response: status_code=${status_code ?? "null"}`;
      await safeAwait(
        db
          .from("pending_embedding")
          .update({
            status: "failed",
            output_file_id: status.output_file_id,
            error_detail: detail,
            completed_at: completedAt,
          })
          .eq("id", pending.id),
        "pending_embedding.update.failed",
      );
      rows_failed++;
    }
  }

  // Any row that didn't get a matching output line is also a failure.
  const seenCustomIds = new Set(lines.map((line) => {
    try {
      return (JSON.parse(line) as BatchOutputLine).custom_id;
    } catch {
      return "";
    }
  }));
  for (const [customId, pending] of byCustomId) {
    if (seenCustomIds.has(customId)) continue;
    await safeAwait(
      db
        .from("pending_embedding")
        .update({
          status: "failed",
          output_file_id: status.output_file_id,
          error_detail: "no_output_line_for_custom_id",
          completed_at: completedAt,
        })
        .eq("id", pending.id),
      "pending_embedding.update.no_output_line",
    );
    rows_failed++;
  }

  return { rows_succeeded, rows_failed };
}

async function countSubmittedForBatch(
  db: SupabaseClient,
  batchId: string,
): Promise<number> {
  const { count } = await db
    .from("pending_embedding")
    .select("id", { count: "exact", head: true })
    .eq("status", "submitted")
    .eq("batch_id", batchId);
  return count ?? 0;
}

async function failBatch(
  db: SupabaseClient,
  batchId: string,
  detail: string,
): Promise<void> {
  await safeAwait(
    db
      .from("pending_embedding")
      .update({
        status: "failed",
        error_detail: detail,
        completed_at: new Date().toISOString(),
      })
      .eq("batch_id", batchId)
      .eq("status", "submitted"),
    "pending_embedding.update.batch_failed",
  );
}
