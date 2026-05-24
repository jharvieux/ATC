/**
 * BP32 §32.11.2 — help_submission_rate per-tenant abuse dimension.
 *
 * **PER-DAY semantics** — diverges from the other 5 BP27 dimensions
 * which are per-billing-period. The state machine here advances over a
 * single day; the `help-submission-daily-reset` cron at 00:05 UTC
 * resets `help_submission_count` and `help_submission_limit_state` for
 * every tenant. Documented in MEMORY D-068.
 *
 * State transitions (monotonic within the day):
 *   ok → soft1 (≥ 20) → soft2 (≥ 50) → hard (≥ 100)
 *
 * Enforcement:
 *   - soft1: admin in-app banner via sendOperatorAlert (severity 'low');
 *     no tenant notification, no throttle.
 *   - soft2: email tenant owner (TODO operator-content); throttle to
 *     1 submission per 10 minutes — caller checks
 *     `last_submission_at` from tenant_usage_metrics for this.
 *   - hard: block submission for the rest of the day; surface the
 *     §32.11.2 "paused until tomorrow" banner.
 *
 * The caller (POST /api/help/bugs, POST /api/help/features) invokes
 * `checkHelpSubmissionRate` BEFORE inserting the bug_submissions /
 * feature_requests row. On `{allowed: false}` no row is created.
 * On `{allowed: true}`, the caller proceeds and then invokes
 * `incrementHelpSubmissionCounter` to bump the counter + advance state.
 *
 * The two-step shape mirrors `customer-rate-limit.ts` and keeps the
 * abuse counter from incrementing on PII-quarantined submissions.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";

const SOFT1 = 20;
const SOFT2 = 50;
const HARD = 100;
const SOFT2_THROTTLE_SECONDS = 10 * 60; // 1 submission per 10 minutes at soft2

export type HelpSubmissionState = "ok" | "soft1" | "soft2" | "hard";

interface MetricsRow {
  help_submission_count: number;
  help_submission_limit_state: HelpSubmissionState;
  last_recomputed_at: string | null;
  billing_period: string;
}

export interface CheckResult {
  allowed: boolean;
  state: HelpSubmissionState;
  count_today: number;
  message?: string;
}

const HARD_BLOCKED_MESSAGE =
  "Help submissions paused until tomorrow. Please contact platform support directly if urgent.";
const SOFT2_THROTTLED_MESSAGE =
  "We're receiving a lot of reports from your tenant. Please wait a few minutes before submitting another.";

/**
 * Compute the appropriate state for a given count. Monotonic — once
 * the day's counter reaches a threshold, the state only advances; the
 * daily reset cron is the only path back to 'ok'.
 */
function stateForCount(count: number): HelpSubmissionState {
  if (count >= HARD) return "hard";
  if (count >= SOFT2) return "soft2";
  if (count >= SOFT1) return "soft1";
  return "ok";
}

async function loadCurrentMetrics(db: SupabaseClient, tenant_id: string): Promise<MetricsRow | null> {
  // Most-recent metrics row for the tenant (any billing_period — the per-day
  // help_submission_count is reset by the cron regardless of billing period).
  const { data } = await db
    .from("tenant_usage_metrics")
    .select("help_submission_count, help_submission_limit_state, last_recomputed_at, billing_period")
    .eq("tenant_id", tenant_id)
    .order("last_recomputed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as MetricsRow | null) ?? null;
}

/**
 * Check whether a help submission should be allowed RIGHT NOW for this
 * tenant. Does NOT increment — the caller invokes
 * `incrementHelpSubmissionCounter` on a successful (non-quarantined)
 * insert.
 */
export async function checkHelpSubmissionRate(
  db: SupabaseClient,
  tenant_id: string,
): Promise<CheckResult> {
  const metrics = await loadCurrentMetrics(db, tenant_id);
  if (!metrics) {
    // No metrics row yet for this tenant — first submission ever. Allow.
    return { allowed: true, state: "ok", count_today: 0 };
  }

  const state = metrics.help_submission_limit_state;
  const count = metrics.help_submission_count;

  if (state === "hard") {
    return { allowed: false, state, count_today: count, message: HARD_BLOCKED_MESSAGE };
  }
  if (state === "soft2") {
    // Throttle: deny if last submission within 10 minutes.
    if (metrics.last_recomputed_at) {
      const elapsed = (Date.now() - new Date(metrics.last_recomputed_at).getTime()) / 1000;
      if (elapsed < SOFT2_THROTTLE_SECONDS) {
        return { allowed: false, state, count_today: count, message: SOFT2_THROTTLED_MESSAGE };
      }
    }
  }
  return { allowed: true, state, count_today: count };
}

/**
 * Increment the tenant's help_submission_count + advance state if the
 * new count crosses a threshold. Returns the new state for caller
 * audit. Caller invokes this AFTER a successful insert (NOT on
 * quarantine — see customer-rate-limit.ts for the parallel decision).
 */
export async function incrementHelpSubmissionCounter(
  db: SupabaseClient,
  tenant_id: string,
): Promise<{ new_state: HelpSubmissionState; new_count: number; transitioned: boolean }> {
  const existing = await loadCurrentMetrics(db, tenant_id);
  const prevCount = existing?.help_submission_count ?? 0;
  const prevState = existing?.help_submission_limit_state ?? "ok";
  const newCount = prevCount + 1;
  const newState = stateForCount(newCount);
  const transitioned = newState !== prevState;
  const now = new Date().toISOString();

  if (existing) {
    await db
      .from("tenant_usage_metrics")
      .update({
        help_submission_count: newCount,
        help_submission_limit_state: newState,
        help_submission_state_changed_at: transitioned ? now : undefined,
        last_recomputed_at: now,
      })
      .eq("tenant_id", tenant_id)
      .eq("billing_period", existing.billing_period);
  } else {
    // No metrics row yet — let the existing recompute path create it
    // on the next nightly run. For v1 we skip rather than synthesize a
    // billing_period; counter starts at 0 and advances naturally.
  }

  if (transitioned) {
    // §32.11.2 enforcement — at soft1 admin in-app banner; at soft2 email
    // tenant owner; at hard alert platform admin.
    if (newState === "soft1") {
      await sendOperatorAlert({
        severity: "low",
        signal: "help_submission_rate_soft1",
        detail: `Tenant ${tenant_id} reached help_submission_rate soft1 (${newCount} submissions today).`,
        payload: { tenant_id, count: newCount },
      });
    } else if (newState === "soft2") {
      await sendOperatorAlert({
        severity: "medium",
        signal: "help_submission_rate_soft2",
        detail: `Tenant ${tenant_id} reached help_submission_rate soft2 (${newCount} submissions today). Throttling to 1 per 10 min.`,
        payload: { tenant_id, count: newCount },
      });
    } else if (newState === "hard") {
      await sendOperatorAlert({
        severity: "high",
        signal: "help_submission_rate_hard",
        detail: `Tenant ${tenant_id} hit help_submission_rate hard cap (${newCount}). Further submissions blocked until daily reset.`,
        payload: { tenant_id, count: newCount },
      });
    }
  }

  return { new_state: newState, new_count: newCount, transitioned };
}
