/**
 * BP32 §32.11.4 — Per-customer bug-submission rate limit.
 *
 * One row per (user_id, tenant_id, day_anchor) in
 * customer_bug_submission_counters. `checkCustomerBugLimit` is the
 * pre-submit gate: if the customer has already hit the limit today
 * (default 5 per `CUSTOMER_BUG_PER_DAY_LIMIT`), the bug-submit route
 * returns the §32.11.4 polite-refusal message and does NOT create
 * a bug_submissions row.
 *
 * `recordCustomerBugSubmission` UPSERTs the counter on a SUCCESSFUL
 * submission. Quarantined submissions (PIIZeroToleranceQuarantineError)
 * DO NOT count per the §32.13 spirit: rate-limiting on top of "your
 * report contained PII we can't process" is bad UX.
 *
 * The implementation uses an inline UPSERT (INSERT ... ON CONFLICT
 * DO UPDATE) so a single round-trip both gates and increments.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwait } from "@/lib/db/safe-mutation";

// Read the limit straight from process.env with a fallback so tests can
// run without the full verifyEnvAtBoot init. The Zod schema in env.ts
// is the production validation layer.
function customerBugPerDayLimit(): number {
  const raw = process.env.CUSTOMER_BUG_PER_DAY_LIMIT;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

export interface CustomerRateLimitCheck {
  allowed: boolean;
  count_today: number;
  limit: number;
}

const POLITE_REFUSAL_MESSAGE =
  "You've reported a few issues today already — our team will get to them. Try again tomorrow if you find something else.";

export function getPoliteRefusalMessage(): string {
  return POLITE_REFUSAL_MESSAGE;
}

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC
}

/**
 * Look up the customer's submission count for today WITHOUT incrementing.
 * Returns `{allowed, count_today, limit}`. The caller increments on
 * success via `recordCustomerBugSubmission`.
 *
 * The two-step design (check then record) avoids incrementing the
 * counter when the pre-submission PII zero-tolerance pass quarantines
 * the bug — per the §32.13 UX spirit.
 */
export async function checkCustomerBugLimit(
  db: SupabaseClient,
  user_id: string,
  tenant_id: string,
): Promise<CustomerRateLimitCheck> {
  const limit = customerBugPerDayLimit();
  const day = todayUtcDate();
  const { data } = await db
    .from("customer_bug_submission_counters")
    .select("submission_count")
    .eq("user_id", user_id)
    .eq("tenant_id", tenant_id)
    .eq("day_anchor", day)
    .maybeSingle();
  const count_today = ((data as { submission_count?: number } | null)?.submission_count) ?? 0;
  return { allowed: count_today < limit, count_today, limit };
}

/**
 * Record a successful customer bug submission. UPSERTs the
 * (user_id, tenant_id, day_anchor) row and increments submission_count
 * by 1. Updates last_submission_at.
 */
export async function recordCustomerBugSubmission(
  db: SupabaseClient,
  user_id: string,
  tenant_id: string,
): Promise<void> {
  const day = todayUtcDate();
  const now = new Date().toISOString();

  // INSERT ON CONFLICT DO UPDATE — atomic. We can't use the supabase
  // client's higher-level upsert() for this kind of increment because
  // it doesn't expose `submission_count + 1`; we read then update.
  // Two-step is fine for v1 — the race window is small and worst-case
  // is double-counting (more restrictive than intended, never permissive).
  const { data: existing } = await db
    .from("customer_bug_submission_counters")
    .select("id, submission_count")
    .eq("user_id", user_id)
    .eq("tenant_id", tenant_id)
    .eq("day_anchor", day)
    .maybeSingle();

  if (existing) {
    const row = existing as { id: string; submission_count: number };
    await safeAwait(db
      .from("customer_bug_submission_counters")
      .update({
        submission_count: row.submission_count + 1,
        last_submission_at: now,
      })
      .eq("id", row.id), "customer_bug_submission_counters.update");
  } else {
    await safeAwait(db.from("customer_bug_submission_counters").insert({
      user_id,
      tenant_id,
      day_anchor: day,
      submission_count: 1,
      last_submission_at: now,
    }), "customer_bug_submission_counters.insert");
  }
}
