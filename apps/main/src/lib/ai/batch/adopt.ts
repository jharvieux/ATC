// §27.12 / #1696 — adopt stranded ai_batch_requests rows.
//
// flush.ts claims rows to 'submitted', submits the batch to Anthropic, stamps
// anthropic_batch_id + submitted_at onto the rows, inserts an ai_batch_jobs
// row, then links the rows to it. If the process dies AFTER the stamp but
// before the insert/link finishes, rows are left status='submitted',
// anthropic_batch_id set, batch_job_id NULL — a real, paid-for Anthropic batch
// is in flight that no job row references, so the reconciler never polls it and
// the rows never resolve.
//
// This sweep recovers them: group stranded rows by anthropic_batch_id,
// find-or-create the ai_batch_jobs row for that batch (anthropic_batch_id is
// UNIQUE on ai_batch_jobs — the dedup key, D-091 #24), and link the rows. The
// normal reconcile loop then polls the job and processes results exactly as if
// the flush had finished the link itself.
//
// We deliberately do NOT reset stranded rows to 'pending': that orphans the
// live batch AND resubmits its content — double spend, D-091 #21. Adoption is
// the only recovery that neither loses nor re-pays for the batch.

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwait } from "@/lib/db/safe-mutation";
import type { BatchablePurpose } from "./types";

// Only adopt rows stranded longer than this. A healthy flush stamps
// submitted_at=now and links within milliseconds, so its rows never match;
// the gate ensures we only touch rows a crash genuinely abandoned, never a
// flush that's mid-insert.
const STRANDED_THRESHOLD_MINUTES = 30;

// Cap per sweep. The crash window is milliseconds so real stranded volume is
// tiny; the bound keeps the sweep inside the reconciler's timeout budget and,
// since batches are ≤50 rows and rows of one batch share a submitted_at, keeps
// each batch's rows contiguous under the submitted_at ordering.
const MAX_STRANDED_PER_SWEEP = 500;

interface StrandedRow {
  id: string;
  purpose: BatchablePurpose;
  anthropic_batch_id: string;
}

export interface AdoptResult {
  batches_adopted: number;
  requests_adopted: number;
}

export async function adoptStrandedBatches(args: {
  db: SupabaseClient;
  olderThanMinutes?: number;
}): Promise<AdoptResult> {
  const { db, olderThanMinutes = STRANDED_THRESHOLD_MINUTES } = args;
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  const result: AdoptResult = { batches_adopted: 0, requests_adopted: 0 };

  const { data, error } = await db
    // d091-allow:service-role-tenant — platform recovery sweep spans all tenants' stranded rows for a given Anthropic batch by design; per-row tenant attribution happens later in reconcile.
    .from("ai_batch_requests")
    .select("id, purpose, anthropic_batch_id")
    .eq("status", "submitted")
    .is("batch_job_id", null)
    .not("anthropic_batch_id", "is", null)
    .lt("submitted_at", cutoff)
    .order("submitted_at", { ascending: true })
    .limit(MAX_STRANDED_PER_SWEEP);
  if (error) {
    throw new Error(`adoptStrandedBatches: stranded lookup failed: ${error.message}`);
  }
  const stranded = (data ?? []) as StrandedRow[];
  if (stranded.length === 0) return result;

  const byBatch = new Map<string, StrandedRow[]>();
  for (const row of stranded) {
    const list = byBatch.get(row.anthropic_batch_id) ?? [];
    list.push(row);
    byBatch.set(row.anthropic_batch_id, list);
  }

  for (const [anthropicBatchId, rows] of byBatch) {
    const jobId = await findOrCreateJob({
      db,
      anthropicBatchId,
      purpose: rows[0]!.purpose,
      requestCount: rows.length,
    });

    // Link only rows still stranded — CAS-guard so a concurrent flush that
    // finished its own link in the meantime isn't clobbered (D-091 #7).
    const linked = await safeAwait(
      db
        // d091-allow:service-role-tenant — platform recovery sweep links one batch's rows across all tenants by design.
        .from("ai_batch_requests")
        .update({ batch_job_id: jobId })
        .in(
          "id",
          rows.map((r) => r.id),
        )
        .eq("status", "submitted")
        .is("batch_job_id", null)
        .select("id"),
      "ai_batch_requests.adopt_link",
    );

    result.batches_adopted++;
    result.requests_adopted += linked?.length ?? 0;
  }

  return result;
}

// Find the ai_batch_jobs row for this batch (it exists when the crash landed
// after the job insert but before the link) or create it. anthropic_batch_id
// is UNIQUE, so a concurrent creator surfaces as 23505 — re-select rather than
// fail (D-091 #24).
async function findOrCreateJob(args: {
  db: SupabaseClient;
  anthropicBatchId: string;
  purpose: BatchablePurpose;
  requestCount: number;
}): Promise<string> {
  const { db, anthropicBatchId, purpose, requestCount } = args;

  const { data: existing, error: selErr } = await db
    .from("ai_batch_jobs")
    .select("id")
    .eq("anthropic_batch_id", anthropicBatchId)
    .maybeSingle();
  if (selErr) {
    throw new Error(
      `adoptStrandedBatches: job lookup failed for batch ${anthropicBatchId}: ${selErr.message}`,
    );
  }
  if (existing) return (existing as { id: string }).id;

  const { data: inserted, error: insErr } = await db
    .from("ai_batch_jobs")
    .insert({
      anthropic_batch_id: anthropicBatchId,
      purpose,
      request_count: requestCount,
      // 'submitted' so the very next reconcile pass polls it like any other job.
      status: "submitted",
    })
    .select("id")
    .single();
  if (insErr) {
    if ((insErr as { code?: string }).code === "23505") {
      const { data: raced, error: raceErr } = await db
        .from("ai_batch_jobs")
        .select("id")
        .eq("anthropic_batch_id", anthropicBatchId)
        .single();
      if (raceErr) {
        throw new Error(
          `adoptStrandedBatches: job re-select after 23505 failed for batch ${anthropicBatchId}: ${raceErr.message}`,
        );
      }
      return (raced as { id: string }).id;
    }
    throw new Error(
      `adoptStrandedBatches: job insert failed for batch ${anthropicBatchId}: ${insErr.message}`,
    );
  }
  return (inserted as { id: string }).id;
}
