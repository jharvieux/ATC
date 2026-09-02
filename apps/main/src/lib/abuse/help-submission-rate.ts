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
 *   - soft2: email tenant owner via abuse.state_transition → abuse-state-transition-notify
 *     Inngest function (dimension="help_submission"). Throttle: naturally at-most-once
 *     per day because the state machine is monotonic; the daily reset cron is the only
 *     path back to 'ok'. Also throttles submissions to 1 per 10 minutes — caller checks
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
import { safeAwait } from "@/lib/db/safe-mutation";
import { dispatchTransitionOutbox, type TransitionOutboxRow } from "./state-machine";

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
function currentBillingPeriodRange(): string {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10);
  return `[${start},${end})`;
}

async function loadCurrentMetrics(db: SupabaseClient, tenant_id: string): Promise<MetricsRow | null> {
  // Most-recent metrics row for the tenant (any billing_period — the per-day
  // help_submission_count is reset by the cron regardless of billing period).
  // safeAwait so a read FAILURE throws (caller surfaces 5xx, submission denied)
  // instead of being swallowed as `null` — which checkHelpSubmissionRate would
  // read as "first submission ever" and ALLOW, bypassing the hard cap on any
  // transient DB error (D-091 fail-closed).
  const data = await safeAwait(
    db
      .from("tenant_usage_metrics")
      .select("help_submission_count, help_submission_limit_state, last_recomputed_at, billing_period")
      .eq("tenant_id", tenant_id)
      .order("last_recomputed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    "tenant_usage_metrics.load-current-metrics",
  );
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
  const result = await safeAwait(
    db.rpc("increment_help_submission_usage", {
      p_tenant_id: tenant_id,
      p_billing_period: currentBillingPeriodRange(),
      p_soft1: SOFT1,
      p_soft2: SOFT2,
      p_hard: HARD,
    }),
    "tenant_usage_metrics.rpc.increment_help_submission",
  );
  const row = (Array.isArray(result) ? result[0] : result) as {
    new_state: HelpSubmissionState;
    new_count: number;
    transitioned: boolean;
    event_id: string | null;
    event_tenant_id: string | null;
    event_dimension: string | null;
    event_from_state: string | null;
    event_to_state: string | null;
    event_metric_value: string | number | null;
    event_threshold_crossed: string | number | null;
    event_created: boolean;
  } | null;
  if (!row) throw new Error("increment_help_submission_usage returned no row");

  const newCount = Number(row.new_count);
  const newState = row.new_state;
  const transitioned = row.transitioned;

  // Help's tenant email is intentionally soft2-only. Soft1/hard retain their
  // operator-alert behavior without widening tenant notification semantics.
  if (row.event_id && row.event_to_state === "soft2") {
    await dispatchTransitionOutbox(db, {
      event_id: row.event_id,
      event_tenant_id: row.event_tenant_id!,
      event_dimension: row.event_dimension!,
      event_from_state: row.event_from_state!,
      event_to_state: row.event_to_state,
      event_metric_value: row.event_metric_value!,
      event_threshold_crossed: row.event_threshold_crossed!,
      event_created: row.event_created,
    } satisfies TransitionOutboxRow);
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
