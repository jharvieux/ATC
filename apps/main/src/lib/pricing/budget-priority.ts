// §33.9.3 — Apify monthly-budget pause priority.
//
// The §33 addendum says: "General-pricing refresh pauses first; the daily
// tracked-sailings (price-watch) refresh is the last to pause, so
// subscriber watches keep evaluating as long as possible."
//
// Implementation: a single monthly cap (APIFY_MONTHLY_BUDGET_USD_CEILING)
// with a percentage split that reserves a slice of that budget for
// tracked-sailings only. General-pricing pauses when spend > 80% of total;
// tracked-sailings keeps going until spend > 100%.

const DEFAULT_GENERAL_PCT = 80;

export function monthlyBudgetCapUsd(): number {
  const raw = parseFloat(process.env.APIFY_MONTHLY_BUDGET_USD_CEILING ?? "500");
  return Number.isFinite(raw) && raw > 0 ? raw : 500;
}

/** Sub-cap for general-pricing refreshes (monthly itinerary, etc.).
 *  Defaults to 80% of the monthly cap; configurable via
 *  APIFY_GENERAL_PRICING_BUDGET_PCT (0-100). */
export function generalPricingBudgetUsd(): number {
  const raw = parseFloat(process.env.APIFY_GENERAL_PRICING_BUDGET_PCT ?? String(DEFAULT_GENERAL_PCT));
  const pct = Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : DEFAULT_GENERAL_PCT;
  return monthlyBudgetCapUsd() * (pct / 100);
}

export type RefreshKind = "general_pricing" | "tracked_sailings";

/** Pure: should a refresh of the given kind be allowed at the current spend?
 *  - General pricing pauses at generalPricingBudgetUsd().
 *  - Tracked sailings pauses at the full monthly cap.
 *  Returns { paused: false } when allowed; { paused: true, reason } otherwise. */
export function budgetGate(
  kind: RefreshKind,
  currentMonthlySpendUsd: number,
): { paused: false } | { paused: true; reason: string; cap_usd: number; spend_usd: number } {
  const total = monthlyBudgetCapUsd();
  if (kind === "tracked_sailings") {
    if (currentMonthlySpendUsd >= total) {
      return {
        paused: true,
        reason: "apify_monthly_budget_exhausted",
        cap_usd: total,
        spend_usd: currentMonthlySpendUsd,
      };
    }
    return { paused: false };
  }
  // general_pricing
  const sub = generalPricingBudgetUsd();
  if (currentMonthlySpendUsd >= sub) {
    return {
      paused: true,
      reason: "apify_general_pricing_budget_exhausted",
      cap_usd: sub,
      spend_usd: currentMonthlySpendUsd,
    };
  }
  return { paused: false };
}
