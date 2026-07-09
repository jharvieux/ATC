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
// flush retries cleanly instead of resubmitting.
//
// #1696 — the remaining crash window (between a successful submit and the
// ai_batch_jobs insert/link below) no longer strands rows unrecoverably: right
// after submit we stamp anthropic_batch_id + submitted_at onto the claimed rows
// (see below), so a crash before the job insert leaves rows that record which
// live batch they belong to. The reconcile adoption sweep (adopt.ts) then
// find-or-creates the job and links them — no orphaned paid-for batch, no
// resubmission.

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
 * upward once we see real volume. #1743: reconcile.ts's job rollup is now a
 * DB-side SUM RPC with no PostgREST row cap, so raising this past ~1000 no
 * longer risks a silent rollup undercount the way the old .select().limit()
 * aggregate did. That said, the pending-rows SELECT just below this constant
 * is still a single `.limit(MAX_REQUESTS_PER_BATCH)` call — PostgREST's
 * db-max-rows (~1000) would silently cap it, so raising this value past
 * ~1000 would need that SELECT paginated with `.range()` (see #1745's model
 * in apps/rag/src/lib/embeddings/batch/flush.ts) before it could actually
 * flush more than ~1000 requests per batch.
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
    const released = await safeAwait(
      db
        // d091-allow:service-role-tenant — platform cron bundles all tenants' pending requests into one Anthropic batch by design; no tenant_id filter is correct here.
        .from("ai_batch_requests")
        .update({ status: "pending" })
        .in("id", pendingIds)
        .eq("status", "submitted")
        .is("batch_job_id", null)
        .select("id"),
      "ai_batch_requests.release_claim_on_submit_failure",
    );
    if (!released || released.length !== pendingIds.length) {
      // Don't throw here — we're already unwinding from the real submit
      // failure and a second thrown error would mask it. Log loudly so an
      // operator can find rows stranded at 'submitted' with no job.
      console.error(
        `[batch:flush] failed to fully release claim after submit failure: expected ${pendingIds.length}, released ${released?.length ?? 0} rows may be stranded`,
      );
    }
    throw err;
  }

  // #1696 — stamp the Anthropic batch id (and submit time) onto the claimed
  // rows BEFORE inserting the job. If we crash after this point but before the
  // job insert/link below, the rows still record which live batch they belong
  // to, so the reconcile adoption sweep can recover them into a job instead of
  // orphaning a paid-for batch (resetting them to 'pending' would double-submit
  // — D-091 #21). submitted_at now marks actual submit time (previously set at
  // link) so the sweep can age-gate stranded rows against a real timestamp.
  const stamped = await safeAwait(
    db
      // d091-allow:service-role-tenant — platform cron stamps all tenants' rows in one batch by design; no tenant_id filter is correct here.
      .from("ai_batch_requests")
      .update({
        anthropic_batch_id: submitted.batch_id,
        submitted_at: new Date().toISOString(),
      })
      .in("id", pendingIds)
      .eq("status", "submitted")
      .select("id"),
    "ai_batch_requests.stamp_batch_id",
  );
  if (!stamped || stamped.length !== pendingIds.length) {
    // The batch is live at Anthropic; whatever rows DID stamp are recoverable
    // by the adoption sweep. Fail loud so the missing-job condition is visible.
    throw new Error(
      `flushPendingForPurpose: expected to stamp ${pendingIds.length} rows with batch id ${submitted.batch_id}, stamped ${stamped?.length ?? 0}`,
    );
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

  // Link the already-claimed, already-stamped requests to the job. They're
  // 'submitted' with submitted_at + anthropic_batch_id set from the steps
  // above; this just attaches batch_job_id.
  const linked = await safeAwait(
    db
      // d091-allow:service-role-tenant — platform cron bundles all tenants' pending requests into one Anthropic batch by design; no tenant_id filter is correct here.
      .from("ai_batch_requests")
      .update({ batch_job_id: job.id })
      .in("id", pendingIds)
      .eq("status", "submitted")
      .select("id"),
    "ai_batch_requests.link_to_job",
  );
  if (!linked || linked.length !== pendingIds.length) {
    // The batch was already submitted to Anthropic — these rows are now
    // stranded at 'submitted' with no batch_job_id (see #1696) rather than
    // silently unlinked.
    throw new Error(
      `flushPendingForPurpose: expected to link ${pendingIds.length} rows to job ${job.id}, linked ${linked?.length ?? 0}`,
    );
  }

  return { flushed: pending.length, batch_id: submitted.batch_id, remaining };
}
