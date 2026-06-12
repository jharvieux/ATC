// §27.12 — Poll submitted Anthropic batches, parse results, emit
// per-row completion events.
//
// Called by the reconcile Inngest cron every 5 minutes. For each
// ai_batch_jobs row in status='submitted' or 'processing':
//   1. Fetch the current Anthropic status.
//   2. If processing_status !== 'ended', update anthropic_processing_status + leave.
//   3. If 'ended':
//      a. Stream results, pair each result row to ai_batch_requests via custom_id.
//      b. For each row: write result_text / error_detail / cost_cents,
//         update tenant_usage_metrics, emit completion / failure event.
//      c. Flip the job to status='completed' with summed totals.
//
// Cost attribution: each successful result row produces one cost
// increment on tenant_usage_metrics.ai_cost_cents — identical shape to
// the direct-call path in instrumentedClaudeCall. The reconciler reads
// the model from the result message and computes via getCostEstimate
// (already public from lib/ai/pricing.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import { inngest } from "@/inngest/client";
import {
  getAnthropicBatchStatus,
  getAnthropicBatchResults,
  logAndIncrement,
  type BatchResultRow,
} from "@/lib/ai/call-wrapper";
import { getCostEstimate } from "@/lib/ai/pricing";
import { safeAwait } from "@/lib/db/safe-mutation";
import type { BatchablePurpose, BatchRequestCompletedPayload, BatchRequestFailedPayload } from "./types";

interface JobRow {
  id: string;
  anthropic_batch_id: string;
  purpose: BatchablePurpose;
  request_count: number;
  status: string;
}

interface RequestRow {
  id: string;
  tenant_id: string;
  purpose: BatchablePurpose;
  custom_id: string;
  caller_metadata: Record<string, unknown> | null;
  status: string;
}

export interface ReconcileResult {
  jobs_polled: number;
  jobs_completed: number;
  requests_succeeded: number;
  requests_failed: number;
}

export async function reconcileSubmittedBatches(args: {
  db: SupabaseClient;
}): Promise<ReconcileResult> {
  const { db } = args;
  const result: ReconcileResult = {
    jobs_polled: 0,
    jobs_completed: 0,
    requests_succeeded: 0,
    requests_failed: 0,
  };

  // Pick up to 20 jobs to poll per reconciler run. More than that and
  // we risk running past Inngest's per-function timeout. With 5-minute
  // cadence, 20 per run = 240/hour reconciliations capacity.
  const { data: jobs, error: jobsErr } = await db
    .from("ai_batch_jobs")
    .select("id, anthropic_batch_id, purpose, request_count, status")
    .in("status", ["submitted", "processing"])
    .order("submitted_at", { ascending: true })
    .limit(20);
  if (jobsErr) {
    throw new Error(`reconcileSubmittedBatches: jobs lookup failed: ${jobsErr.message}`);
  }
  const submittedJobs = (jobs ?? []) as JobRow[];

  for (const job of submittedJobs) {
    result.jobs_polled++;
    const status = await getAnthropicBatchStatus(job.anthropic_batch_id);

    // Update last-known processing status either way for observability.
    if (status.processing_status !== "ended") {
      await safeAwait(
        db
          .from("ai_batch_jobs")
          .update({
            status: "processing",
            anthropic_processing_status: status.processing_status,
            reconciled_at: new Date().toISOString(),
          })
          .eq("id", job.id),
        "ai_batch_jobs.update.processing",
      );
      continue;
    }

    // Batch ended — fetch all the request rows so we can pair results
    // back to (tenant_id, caller_metadata).
    const { data: requestsData, error: requestsErr } = await db
      // d091-allow:service-role-tenant — platform reconcile cron processes all tenants' requests for a given batch by design; tenant isolation applied per-row during result attribution.
      .from("ai_batch_requests")
      .select("id, tenant_id, purpose, custom_id, caller_metadata, status")
      .eq("batch_job_id", job.id);
    if (requestsErr) {
      throw new Error(
        `reconcileSubmittedBatches: requests lookup failed for job ${job.id}: ${requestsErr.message}`,
      );
    }
    const requestRows = (requestsData ?? []) as RequestRow[];
    const byCustomId = new Map<string, RequestRow>(
      requestRows.map((r) => [r.custom_id, r]),
    );

    let totalInput = 0n;
    let totalOutput = 0n;
    let totalCostCents = 0n;
    let perJobSucceeded = 0;
    let perJobFailed = 0;

    for await (const row of getAnthropicBatchResults(job.anthropic_batch_id)) {
      await processOneResult({
        db,
        result: row,
        byCustomId,
        accumulate: (succ, fail, inTok, outTok, costCents) => {
          if (succ) perJobSucceeded++;
          if (fail) perJobFailed++;
          totalInput += BigInt(inTok);
          totalOutput += BigInt(outTok);
          totalCostCents += BigInt(costCents);
        },
      });
    }

    // Mark the job completed with totals.
    await safeAwait(
      db
        .from("ai_batch_jobs")
        .update({
          status: "completed",
          anthropic_processing_status: status.processing_status,
          completed_at: new Date().toISOString(),
          reconciled_at: new Date().toISOString(),
          total_input_tokens: Number(totalInput),
          total_output_tokens: Number(totalOutput),
          total_cost_cents: Number(totalCostCents),
        })
        .eq("id", job.id),
      "ai_batch_jobs.update.completed",
    );

    result.jobs_completed++;
    result.requests_succeeded += perJobSucceeded;
    result.requests_failed += perJobFailed;
  }

  return result;
}

async function processOneResult(args: {
  db: SupabaseClient;
  result: BatchResultRow;
  byCustomId: Map<string, { id: string; tenant_id: string; purpose: BatchablePurpose; caller_metadata: Record<string, unknown> | null }>;
  accumulate: (
    succeeded: boolean,
    failed: boolean,
    input_tokens: number,
    output_tokens: number,
    cost_cents: number,
  ) => void;
}): Promise<void> {
  const { db, result, byCustomId, accumulate } = args;
  const req = byCustomId.get(result.custom_id);
  if (!req) {
    // Anthropic returned a custom_id we didn't submit — shouldn't happen.
    // Log and move on rather than fail the whole reconciliation.
    console.warn(
      `[batch:reconcile] unknown custom_id from Anthropic: ${result.custom_id}`,
    );
    return;
  }

  if (result.result.type === "succeeded") {
    const msg = result.result.message;
    const text = msg.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("");
    const input_tokens = msg.usage?.input_tokens ?? 0;
    const output_tokens = msg.usage?.output_tokens ?? 0;
    const model = msg.model ?? "unknown";
    const cost = getCostEstimate({ model, input_tokens, output_tokens });
    const costNumber = Number(cost);

    await safeAwait(
      db
        .from("ai_batch_requests")
        .update({
          status: "completed",
          result_text: text,
          result_metadata: {
            model,
            input_tokens,
            output_tokens,
            stop_reason: msg.stop_reason,
          },
          cost_cents: costNumber,
          completed_at: new Date().toISOString(),
        })
        .eq("id", req.id),
      "ai_batch_requests.update.succeeded",
    );

    // Cost attribution: same shape as instrumentedClaudeCall's per-call
    // increment — one ai_call_log row + one tenant_usage_metrics RPC.
    // Best-effort: if either fails, don't block the rest of the batch
    // (per-row failure can't poison the whole reconciler run).
    try {
      await logAndIncrement({
        db: db as never, // db is service-role, matches the helper's expected client type
        tenant_id: req.tenant_id,
        conversation_id: null,
        user_id: null,
        model,
        vendor: "anthropic",
        purpose: req.purpose,
        input_tokens,
        output_tokens,
        latency_ms: 0, // batched — no meaningful per-row latency
        cost_cents: cost,
      });
    } catch (err) {
      console.warn(
        `[batch:reconcile] cost attribution failed for tenant ${req.tenant_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Emit completion event so the consumer can do its side effect.
    const payload: BatchRequestCompletedPayload = {
      request_id: req.id,
      tenant_id: req.tenant_id,
      purpose: req.purpose,
      result_text: text,
      caller_metadata: req.caller_metadata,
    };
    await inngest.send({
      name: `ai.batch_request.completed.${req.purpose}` as never,
      data: payload as unknown as Record<string, unknown>,
    });

    accumulate(true, false, input_tokens, output_tokens, costNumber);
    return;
  }

  // Failure paths: errored / canceled / expired all surface as a
  // failure event so the consumer can take the alternate action
  // (retry, fall back to template, escalate, etc.).
  const errorDetail =
    result.result.type === "errored"
      ? `${result.result.error.type}: ${result.result.error.message}`
      : result.result.type;

  await safeAwait(
    db
      .from("ai_batch_requests")
      .update({
        status: "failed",
        error_detail: errorDetail,
        completed_at: new Date().toISOString(),
      })
      .eq("id", req.id),
    "ai_batch_requests.update.failed",
  );

  const failPayload: BatchRequestFailedPayload = {
    request_id: req.id,
    tenant_id: req.tenant_id,
    purpose: req.purpose,
    error_detail: errorDetail,
    caller_metadata: req.caller_metadata,
  };
  await inngest.send({
    name: `ai.batch_request.failed.${req.purpose}` as never,
    data: failPayload as unknown as Record<string, unknown>,
  });

  accumulate(false, true, 0, 0, 0);
}
