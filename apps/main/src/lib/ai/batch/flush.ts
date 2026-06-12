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
  const { count: remainingCount } = await db
    // d091-allow:service-role-tenant — platform cron bundles all tenants' pending requests into one Anthropic batch by design; no tenant_id filter is correct here.
    .from("ai_batch_requests")
    .select("id", { count: "exact", head: true })
    .eq("purpose", purpose)
    .eq("status", "pending");
  const remaining = Math.max(0, (remainingCount ?? 0) - pending.length);

  // Build the Anthropic batch request payload.
  const batchRequests: BatchRequest[] = pending.map((row) => ({
    custom_id: row.custom_id,
    params: row.request_params,
  }));

  // Submit. Failure here means NONE of the rows reach Anthropic —
  // they stay pending, the next flush will re-attempt.
  const submitted = await submitAnthropicBatch({ requests: batchRequests });

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

  // Link the requests to the job + flip them to submitted.
  await safeAwait(
    db
      // d091-allow:service-role-tenant — platform cron bundles all tenants' pending requests into one Anthropic batch by design; no tenant_id filter is correct here.
      .from("ai_batch_requests")
      .update({
        status: "submitted",
        batch_job_id: job.id,
        submitted_at: new Date().toISOString(),
      })
      .in(
        "id",
        pending.map((p) => p.id),
      ),
    "ai_batch_requests.update.submitted",
  );

  return { flushed: pending.length, batch_id: submitted.batch_id, remaining };
}
