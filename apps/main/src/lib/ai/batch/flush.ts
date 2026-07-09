// §27.12 — Collect pending ai_batch_requests for one purpose, submit
// them as a single Anthropic batch, link the rows.
//
// Called by per-purpose Inngest crons. Returns counts so the cron can
// log usefully.
//
// Idempotency: this isn't strictly idempotent — calling twice in
// parallel would create two batches with overlapping content. The
// expected guard is "only one flush cron per purpose, configured
// to not concurrent-run." Inngest provides that via its function
// concurrency setting (concurrency: { limit: 1 }) on the flush
// function.
//
// #1599 — claim-before-send (D-091 #21): the old version called
// submitAnthropicBatch() while rows were still 'pending', and only
// flipped them afterward. A retry of the whole function (Inngest step
// retry, transient failure after submit) would re-select the same
// still-'pending' rows and submit a SECOND Anthropic batch with
// identical content — double spend, and the first batch is orphaned
// (nothing ever links its results back to these rows). Rows are now
// CAS-claimed to 'submitted' status BEFORE the Anthropic call; if the
// call fails, the claim is released back to 'pending' so the next
// flush retries cleanly instead of resubmitting. If the process dies
// in the narrow window between a successful submit and the
// ai_batch_jobs insert/link below, the claimed rows are stranded
// (status='submitted', batch_job_id=null) rather than double-submitted
// — a strictly smaller residual risk, tracked as a follow-up (#1696).

import type { SupabaseClient } from "@supabase/supabase-js";
import { submitAnthropicBatch, type BatchRequest } from "@/lib/ai/call-wrapper";
import { safeAwait } from "@/lib/db/safe-mutation";
import type { BatchablePurpose } from "./types";

interface PendingRow {
  id: string;
  custom_id: string;
  request_params: BatchRequest["params"];
}

export interface FlushResult {
  flushed: number;
  batch_id?: string;
  /** If the flush exceeds this many requests, we slice and recur. */
  remaining: number;
}

/**
 * Anthropic Message Batches max 100,000 requests per batch, 256 MB.
 * We slice at 50 requests/batch for now — keeps payload size very
 * conservative and means a partial-batch failure costs less. Tune
 * upward once we see real volume.
 */
const MAX_REQUESTS_PER_BATCH = 50;

export async function flushPendingForPurpose(args: {
  purpose: BatchablePurpose;
  db: SupabaseClient;
}): Promise<FlushResult> {
  const { purpose, db } = args;

  // Pick the next slice of pending rows, oldest first, for FAIRNESS
  // across tenants — a tenant that enqueued first gets serviced first.
  const { data, error } = await db
    // d091-allow:service-role-tenant — platform cron bundles all tenants' pending requests into one Anthropic batch by design; no tenant_id filter is correct here.
    .from("ai_batch_requests")
    .select("id, custom_id, request_params")
    .eq("purpose", purpose)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(MAX_REQUESTS_PER_BATCH);
  if (error) {
    throw new Error(`flushPendingForPurpose: pending lookup failed: ${error.message}`);
  }
  const pending = (data ?? []) as PendingRow[];
  if (pending.length === 0) {
    return { flushed: 0, remaining: 0 };
  }

  // Count remaining beyond this batch so the caller can schedule a
  // re-fire if pending > MAX. Cheaper than a second query: we only
  // need to know whether more exist.
  const { count: remainingCount, error: countErr } = await db
    // d091-allow:service-role-tenant — platform cron bundles all tenants' pending requests into one Anthropic batch by design; no tenant_id filter is correct here.
    .from("ai_batch_requests")
    .select("id", { count: "exact", head: true })
    .eq("purpose", purpose)
    .eq("status", "pending");
  if (countErr) throw new Error(`flushPendingForPurpose: remaining count failed: ${countErr.message}`);
  const remaining = Math.max(0, (remainingCount ?? 0) - pending.length);

  const pendingIds = pending.map((p) => p.id);

  // #1599 — claim-before-send: flip these rows out of 'pending' BEFORE
  // calling Anthropic. Any retry of this whole function after this point
  // sees them as no-longer-pending, so it can't select and resubmit them.
  const claimed = await safeAwait(
    db
      // d091-allow:service-role-tenant — platform cron bundles all tenants' pending requests into one Anthropic batch by design; no tenant_id filter is correct here.
      .from("ai_batch_requests")
      .update({ status: "submitted" })
      .in("id", pendingIds)
      .eq("status", "pending")
      .select("id"),
    "ai_batch_requests.claim_before_send",
  );
  if (!claimed || claimed.length !== pendingIds.length) {
    throw new Error(
      `flushPendingForPurpose: expected to claim ${pendingIds.length} rows, claimed ${claimed?.length ?? 0} — a concurrent flush may have raced this one`,
    );
  }

  // Build the Anthropic batch request payload.
  const batchRequests: BatchRequest[] = pending.map((row) => ({
    custom_id: row.custom_id,
    params: row.request_params,
  }));

  let submitted: Awaited<ReturnType<typeof submitAnthropicBatch>>;
  try {
    submitted = await submitAnthropicBatch({ requests: batchRequests });
  } catch (err) {
    // Anthropic never accepted the batch — release the claim so the next
    // flush retries these rows instead of leaving them stranded as
    // 'submitted' with no job to reconcile against.
    await safeAwait(
      db
        .from("ai_batch_requests")
        .update({ status: "pending" })
        .in("id", pendingIds)
        .eq("status", "submitted")
        .is("batch_job_id", null),
      "ai_batch_requests.release_claim_on_submit_failure",
    );
    throw err;
  }

  // Create the ai_batch_jobs row.
  const jobRow = await safeAwait(
    db
      .from("ai_batch_jobs")
      .insert({
        anthropic_batch_id: submitted.batch_id,
        purpose,
        request_count: submitted.request_count,
        status: "submitted",
        anthropic_processing_status: submitted.processing_status,
      })
      .select("id")
      .single(),
    "ai_batch_jobs.insert",
  );
  const job = jobRow as unknown as { id: string };

  // Link the already-claimed requests to the job. They're already
  // 'submitted' from the claim step above; this just attaches batch_job_id.
  await safeAwait(
    db
      // d091-allow:service-role-tenant — platform cron bundles all tenants' pending requests into one Anthropic batch by design; no tenant_id filter is correct here.
      .from("ai_batch_requests")
      .update({
        batch_job_id: job.id,
        submitted_at: new Date().toISOString(),
      })
      .in("id", pendingIds)
      .eq("status", "submitted"),
    "ai_batch_requests.link_to_job",
  );

  return { flushed: pending.length, batch_id: submitted.batch_id, remaining };
}
