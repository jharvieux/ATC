// §33.9.3 — budget-priority pure-helper tests.

import { afterEach, describe, expect, it } from "vitest";
import {
  budgetGate,
  generalPricingBudgetUsd,
  monthlyBudgetCapUsd,
} from "../../../src/lib/pricing/budget-priority";

const ORIG_MONTHLY = process.env.APIFY_MONTHLY_BUDGET_USD_CEILING;
const ORIG_PCT = process.env.APIFY_GENERAL_PRICING_BUDGET_PCT;

afterEach(() => {
  process.env.APIFY_MONTHLY_BUDGET_USD_CEILING = ORIG_MONTHLY;
  process.env.APIFY_GENERAL_PRICING_BUDGET_PCT = ORIG_PCT;
});

describe("monthlyBudgetCapUsd", () => {
  it("defaults to 500 when env is unset", () => {
    delete process.env.APIFY_MONTHLY_BUDGET_USD_CEILING;
    expect(monthlyBudgetCapUsd()).toBe(500);
  });

  it("respects an env override", () => {
    process.env.APIFY_MONTHLY_BUDGET_USD_CEILING = "1200";
    expect(monthlyBudgetCapUsd()).toBe(1200);
  });

  it("falls back to 500 on garbage input", () => {
    process.env.APIFY_MONTHLY_BUDGET_USD_CEILING = "not-a-number";
    expect(monthlyBudgetCapUsd()).toBe(500);
  });
});

describe("generalPricingBudgetUsd", () => {
  it("defaults to 80% of the monthly cap", () => {
    process.env.APIFY_MONTHLY_BUDGET_USD_CEILING = "1000";
    delete process.env.APIFY_GENERAL_PRICING_BUDGET_PCT;
    expect(generalPricingBudgetUsd()).toBeCloseTo(800);
  });

  it("respects a custom split percentage", () => {
    process.env.APIFY_MONTHLY_BUDGET_USD_CEILING = "1000";
    process.env.APIFY_GENERAL_PRICING_BUDGET_PCT = "60";
    expect(generalPricingBudgetUsd()).toBeCloseTo(600);
  });

  it("falls back to 80% on invalid percent", () => {
    process.env.APIFY_MONTHLY_BUDGET_USD_CEILING = "1000";
    process.env.APIFY_GENERAL_PRICING_BUDGET_PCT = "200"; // over 100
    expect(generalPricingBudgetUsd()).toBeCloseTo(800);
    process.env.APIFY_GENERAL_PRICING_BUDGET_PCT = "0"; // zero
    expect(generalPricingBudgetUsd()).toBeCloseTo(800);
  });
});

describe("budgetGate — priority ordering", () => {
  it("general-pricing pauses at the sub-cap; tracked-sailings keeps going", () => {
    process.env.APIFY_MONTHLY_BUDGET_USD_CEILING = "1000";
    process.env.APIFY_GENERAL_PRICING_BUDGET_PCT = "80"; // 800

    // At $850 spent: general-pricing PAUSED, tracked-sailings ALLOWED.
    const generalAt850 = budgetGate("general_pricing", 850);
    const trackedAt850 = budgetGate("tracked_sailings", 850);
    expect(generalAt850.paused).toBe(true);
    expect(trackedAt850.paused).toBe(false);
  });

  it("both paused when the full monthly cap is hit", () => {
    process.env.APIFY_MONTHLY_BUDGET_USD_CEILING = "1000";
    process.env.APIFY_GENERAL_PRICING_BUDGET_PCT = "80";

    const generalAt1000 = budgetGate("general_pricing", 1000);
    const trackedAt1000 = budgetGate("tracked_sailings", 1000);
    expect(generalAt1000.paused).toBe(true);
    expect(trackedAt1000.paused).toBe(true);
  });

  it("both allowed at zero spend", () => {
    process.env.APIFY_MONTHLY_BUDGET_USD_CEILING = "1000";
    expect(budgetGate("general_pricing", 0).paused).toBe(false);
    expect(budgetGate("tracked_sailings", 0).paused).toBe(false);
  });

  it("pause signals carry distinct reason codes", () => {
    process.env.APIFY_MONTHLY_BUDGET_USD_CEILING = "1000";
    process.env.APIFY_GENERAL_PRICING_BUDGET_PCT = "80";

    const gen = budgetGate("general_pricing", 900);
    const tra = budgetGate("tracked_sailings", 1100);
    if (gen.paused) {
      expect(gen.reason).toBe("apify_general_pricing_budget_exhausted");
    } else {
      expect.fail("general_pricing should be paused at 900 with 80% sub-cap");
    }
    if (tra.paused) {
      expect(tra.reason).toBe("apify_monthly_budget_exhausted");
    } else {
      expect.fail("tracked_sailings should be paused at 1100 over 1000 cap");
    }
  });
});
