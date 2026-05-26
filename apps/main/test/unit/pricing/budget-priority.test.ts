// §33.9.3 — Apify monthly-budget helper tests (post-D-088 simplification).

import { afterEach, describe, expect, it } from "vitest";
import {
  checkMonthlyBudget,
  monthlyBudgetCapUsd,
} from "../../../src/lib/pricing/budget-priority";

const ORIG_MONTHLY = process.env.APIFY_MONTHLY_BUDGET_USD_CEILING;

afterEach(() => {
  process.env.APIFY_MONTHLY_BUDGET_USD_CEILING = ORIG_MONTHLY;
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
    process.env.APIFY_MONTHLY_BUDGET_USD_CEILING = "0";
    expect(monthlyBudgetCapUsd()).toBe(500);
    process.env.APIFY_MONTHLY_BUDGET_USD_CEILING = "-5";
    expect(monthlyBudgetCapUsd()).toBe(500);
  });
});

describe("checkMonthlyBudget", () => {
  it("returns paused=false when spend is below the cap", () => {
    process.env.APIFY_MONTHLY_BUDGET_USD_CEILING = "1000";
    expect(checkMonthlyBudget(0).paused).toBe(false);
    expect(checkMonthlyBudget(500).paused).toBe(false);
    expect(checkMonthlyBudget(999.99).paused).toBe(false);
  });

  it("returns paused=true with the canonical reason when cap is exceeded", () => {
    process.env.APIFY_MONTHLY_BUDGET_USD_CEILING = "1000";
    const gate = checkMonthlyBudget(1000);
    expect(gate.paused).toBe(true);
    if (gate.paused) {
      expect(gate.reason).toBe("apify_monthly_budget_exhausted");
      expect(gate.cap_usd).toBe(1000);
      expect(gate.spend_usd).toBe(1000);
    }
  });

  it("surfaces cap + spend on the result for caller logging", () => {
    process.env.APIFY_MONTHLY_BUDGET_USD_CEILING = "750";
    const gate = checkMonthlyBudget(800);
    expect(gate.cap_usd).toBe(750);
    expect(gate.spend_usd).toBe(800);
  });

  it("treats exactly-equal spend as paused (cap is inclusive)", () => {
    process.env.APIFY_MONTHLY_BUDGET_USD_CEILING = "100";
    expect(checkMonthlyBudget(100).paused).toBe(true);
  });
});
