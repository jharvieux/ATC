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
//
// #1599 — processOneResult CAS-claims each row (.eq("status","submitted"))
// before attributing cost or emitting a completion/failure event. Without
// this, a crash partway through streaming a batch's results (row 30 of
// 50) leaves the job at status='submitted'; the next 5-minute reconcile
// re-streams the WHOLE batch from Anthropic, and rows 1-29 (already
// 'completed') would otherwise get cost re-incremented and a duplicate
// event emitted. A 0-row CAS result means an earlier run already claimed
// this row — skip cost/event and move on, which is what makes re-running
// the loop from the top idempotent.
//
// #1697 — the job-level total_cost_cents/total_*_tokens rollup is summed
// from ALL persisted 'completed' rows for the job (a post-loop aggregate),
// not just rows this run's loop processed. Before the fix an in-loop
// accumulator undercounted whenever a batch split across reconcile runs:
// rows a prior (crashed) run already completed are skipped by the CAS gate
// below and never re-enter the accumulator. Per-row cost_cents and the
// tenant_usage_metrics increments (what's actually billed) were always
// correct — this fix only concerns the job-level observability rollup.
//
// #1743 — that rollup used to be a `.select(...).limit(job.request_count)`
// aggregate SELECT computed in JS, which PostgREST's ~1000-row db-max-rows
// cap silently truncates regardless of the requested .limit(). It's now the
// ai_batch_requests_rollup() RPC (migration 20260722000015), which sums
// server-side and returns only the aggregate — no rows, no cap to hit.

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

// Shape of the ai_batch_requests_rollup() RPC's single result row (#1743).
// BIGINT columns arrive as number|string over PostgREST — coerce with Number().
interface RollupRow {
  total_cost_cents: number | string;
  total_input_tokens: number | string;
  total_output_tokens: number | string;
}

export interface ReconcileResult {
  jobs_polled: number;
  jobs_completed: number;
  // Per-run accumulator values (#1743 nit) — undercount across a batch that
  // spans multiple reconcile runs, since a row a prior run already claimed
  // never re-enters this run's loop. Fine for cron-log observability; if
  // this is ever surfaced for accuracy, sum from persisted row status
  // instead (as the job-level cost/token rollup above already does).
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
    .select("id, anthropic_batch_id, purpose, status")
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

    let perJobSucceeded = 0;
    let perJobFailed = 0;

    for await (const row of getAnthropicBatchResults(job.anthropic_batch_id)) {
      await processOneResult({
        db,
        result: row,
        byCustomId,
        accumulate: (succ, fail) => {
          if (succ) perJobSucceeded++;
          if (fail) perJobFailed++;
        },
      });
    }

    // #1743 — DB-side SUM rollup (ai_batch_requests_rollup RPC) over every
    // persisted 'completed' row, so a batch reconciled across multiple runs
    // still rolls up the full total (rows an earlier run finished are
    // skipped by the CAS gate and would never re-enter an in-loop
    // accumulator) — and, unlike a `.select().limit()` aggregate, isn't
    // subject to PostgREST's row cap regardless of how many rows completed.
    const { data: rollupData, error: rollupErr } = await db.rpc("ai_batch_requests_rollup", {
      p_batch_job_id: job.id,
    });
    if (rollupErr) {
      throw new Error(
        `reconcileSubmittedBatches: rollup aggregate failed for job ${job.id}: ${rollupErr.message}`,
      );
    }
    const rollup = ((rollupData ?? []) as RollupRow[])[0];
    const totalCostCents = Number(rollup?.total_cost_cents ?? 0);
    const totalInput = Number(rollup?.total_input_tokens ?? 0);
    const totalOutput = Number(rollup?.total_output_tokens ?? 0);

    // Mark the job completed with totals.
    await safeAwait(
      db
        .from("ai_batch_jobs")
        .update({
          status: "completed",
          anthropic_processing_status: status.processing_status,
          completed_at: new Date().toISOString(),
          reconciled_at: new Date().toISOString(),
          total_input_tokens: totalInput,
          total_output_tokens: totalOutput,
          total_cost_cents: totalCostCents,
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
  byCustomId: Map<string, { id: string; tenant_id: string; purpose: BatchablePurpose; caller_metadata: Record<string, unknown> | null; status: string }>;
  accumulate: (succeeded: boolean, failed: boolean) => void;
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

  // Idempotency gate (#1702): only rows still 'submitted' as loaded at the top
  // of THIS reconcile run are ours to process. A row already terminal was
  // finished by a prior run — return before the event is sent so a re-streamed
  // batch (Anthropic has no resume cursor) neither re-emits nor re-attributes
  // cost. This is what lets the completion event be sent BEFORE the CAS-claim
  // below: the send only runs for genuinely-unprocessed rows, and the CAS
  // remains the authoritative guard against a concurrent run double-counting.
  if (req.status !== "submitted") return;

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

    // Emit the completion event BEFORE the CAS-claim (#1702). Previously the
    // row was flipped terminal first and the event sent after; if inngest.send
    // threw, the event was lost forever (the next run's CAS returns 0 rows and
    // skips). Sending first means a crash between send and claim just re-runs
    // both on retry — the deterministic `id` makes Inngest dedup the re-send so
    // it never double-fires. The status gate above guarantees we only reach
    // here for a still-'submitted' row, so an already-processed row from a prior
    // run never re-emits.
    const payload: BatchRequestCompletedPayload = {
      request_id: req.id,
      tenant_id: req.tenant_id,
      purpose: req.purpose,
      result_text: text,
      caller_metadata: req.caller_metadata,
    };
    await inngest.send({
      id: `batch-result-${req.id}`,
      name: `ai.batch_request.completed.${req.purpose}` as never,
      data: payload as unknown as Record<string, unknown>,
    });

    // CAS-claim: authoritative guard for cost attribution. Only proceed if this
    // update actually flipped the row out of 'submitted'. A 0-row result means a
    // concurrent run already claimed it — skip cost (the event is deduped by id).
    const claimed = await safeAwait(
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
        .eq("id", req.id)
        .eq("status", "submitted")
        .select("id"),
      "ai_batch_requests.update.succeeded",
    );
    if (!claimed || claimed.length === 0) {
      return;
    }

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

    accumulate(true, false);
    return;
  }

  // Failure paths: errored / canceled / expired all surface as a
  // failure event so the consumer can take the alternate action
  // (retry, fall back to template, escalate, etc.).
  const errorDetail =
    result.result.type === "errored"
      ? `${result.result.error.type}: ${result.result.error.message}`
      : result.result.type;

  // Send the failure event BEFORE the CAS-claim, same rationale as the success
  // path (#1702): a send that throws after the row was flipped terminal would
  // otherwise lose the event permanently. The deterministic id dedups the retry.
  const failPayload: BatchRequestFailedPayload = {
    request_id: req.id,
    tenant_id: req.tenant_id,
    purpose: req.purpose,
    error_detail: errorDetail,
    caller_metadata: req.caller_metadata,
  };
  await inngest.send({
    id: `batch-result-${req.id}`,
    name: `ai.batch_request.failed.${req.purpose}` as never,
    data: failPayload as unknown as Record<string, unknown>,
  });

  const claimed = await safeAwait(
    db
      .from("ai_batch_requests")
      .update({
        status: "failed",
        error_detail: errorDetail,
        completed_at: new Date().toISOString(),
      })
      .eq("id", req.id)
      .eq("status", "submitted")
      .select("id"),
    "ai_batch_requests.update.failed",
  );
  if (!claimed || claimed.length === 0) {
    return;
  }

  accumulate(false, true);
}
