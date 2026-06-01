// §33.9.3 — Apify monthly-budget cap helper.
//
// D-088 (2026-05-26): the general-pricing path no longer hits Apify
// (DIY CruiseMapper scraper replaces it; see MEMORY D-088 + reality-delta-
// supplement §33.4/§33.9.3 for the rationale). The 80/20 sub-cap that
// previously reserved budget for tracked-sailings is removed — only
// tracked-sailings consumes Apify spend now, so the full monthly cap is
// available to it.
//
// This module is kept (rather than inlining the cap check) so the spend
// path stays testable in isolation, and to centralize
// APIFY_MONTHLY_BUDGET_USD_CEILING parsing for any future Apify-spending
// surface that joins the platform.

export function monthlyBudgetCapUsd(): number {
  const raw = parseFloat(process.env.APIFY_MONTHLY_BUDGET_USD_CEILING ?? "500");
  return Number.isFinite(raw) && raw > 0 ? raw : 500;
}

export interface BudgetCheck {
  paused: boolean;
  reason?: string;
  cap_usd: number;
  spend_usd: number;
}

/** Returns { paused: true } when current month-to-date spend has reached
 *  or exceeded the monthly cap. Tracked-sailings is the only consumer
 *  today (D-088).
 *
 *  capUsdOverride: when provided (e.g. from platform_settings DB row),
 *  takes precedence over the APIFY_MONTHLY_BUDGET_USD_CEILING env var. */
export function checkMonthlyBudget(currentMonthlySpendUsd: number, capUsdOverride?: number): BudgetCheck {
  const cap =
    capUsdOverride !== undefined && Number.isFinite(capUsdOverride) && capUsdOverride > 0
      ? capUsdOverride
      : monthlyBudgetCapUsd();
  if (currentMonthlySpendUsd >= cap) {
    return {
      paused: true,
      reason: "apify_monthly_budget_exhausted",
      cap_usd: cap,
      spend_usd: currentMonthlySpendUsd,
    };
  }
  return { paused: false, cap_usd: cap, spend_usd: currentMonthlySpendUsd };
}
