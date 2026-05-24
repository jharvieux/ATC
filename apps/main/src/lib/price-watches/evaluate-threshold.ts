// BP40 §33.8.4 — threshold evaluator.
//
// Pure function, no IO. Caller (Inngest job, API GET detail route) is
// responsible for fetching the watch + current price; this just decides.
//
// Currency mismatch handling: per spec, we don't auto-convert. The caller
// is expected to log + skip. The evaluator signals this with a 'skip:currency_mismatch'
// outcome so the caller knows the difference between "didn't trigger" and
// "couldn't evaluate".

import type { PriceAmount, PriceWatch } from "./types";

export type EvaluationOutcome =
  | { decision: "trigger"; reason: string }
  | { decision: "no_trigger"; reason: string }
  | { decision: "skip"; reason: "currency_mismatch" | "no_price" | "watch_inactive" };

/**
 * Decide whether a watch should fire given the current price.
 */
export function evaluateThreshold(watch: PriceWatch, current: PriceAmount | null): EvaluationOutcome {
  if (watch.status !== "active") return { decision: "skip", reason: "watch_inactive" };
  if (!current) return { decision: "skip", reason: "no_price" };
  if (current.currency !== watch.baseline_currency) {
    return { decision: "skip", reason: "currency_mismatch" };
  }

  const baseline = watch.baseline_price;
  const cur = current.amount;

  const dollarOk = watch.dollar_threshold != null && cur <= baseline - watch.dollar_threshold;
  const percentOk = watch.percent_threshold != null && cur <= baseline * (1 - watch.percent_threshold / 100);

  switch (watch.threshold_kind) {
    case "dollar_drop":
      return dollarOk
        ? { decision: "trigger", reason: `dollar_drop: $${baseline} → $${cur} (≥ $${watch.dollar_threshold} drop)` }
        : { decision: "no_trigger", reason: "dollar_threshold_not_met" };
    case "percent_drop":
      return percentOk
        ? { decision: "trigger", reason: `percent_drop: $${baseline} → $${cur} (≥ ${watch.percent_threshold}% drop)` }
        : { decision: "no_trigger", reason: "percent_threshold_not_met" };
    case "either":
      if (dollarOk || percentOk) {
        return {
          decision: "trigger",
          reason: dollarOk ? `either(dollar): $${baseline} → $${cur}` : `either(percent): $${baseline} → $${cur}`,
        };
      }
      return { decision: "no_trigger", reason: "neither_threshold_met" };
  }
}

/** Convenience boolean form for tests/callers that don't need the reason string. */
export function shouldTrigger(watch: PriceWatch, current: PriceAmount): boolean {
  return evaluateThreshold(watch, current).decision === "trigger";
}
