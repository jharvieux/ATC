// §27.4.1 / §3.3 — Revenue computation worked examples.

import { describe, it, expect } from "vitest";
import type { PricingTable } from "@/lib/abuse/revenue";
import { computeEffectiveMonthlyRevenue } from "@/lib/abuse/revenue";

// §3.3 seed values — local fixture, not a runtime fallback.
const PRICING: PricingTable = {
  base: {
    byo_research:     { monthly:  1900, annual:  19000 },
    byo_professional: { monthly:  5900, annual:  59000 },
    byo_agency:       { monthly:  9900, annual:  99000 },
    sub_starter:      { monthly:  4900, annual:  49000 },
    sub_pro:          { monthly: 14900, annual: 149000 },
    sub_agency:       { monthly: 24900, annual: 249000 },
  },
  seatLadder: [
    { upTo:        4, monthly: 5900, annual: 59000 },
    { upTo:       10, monthly: 4900, annual: 49000 },
    { upTo: Infinity, monthly: 3900, annual: 39000 },
  ],
};

describe("computeEffectiveMonthlyRevenue", () => {
  it("single-seat monthly Sub-Host Agency = $249.00", () => {
    const cents = computeEffectiveMonthlyRevenue({
      tier_code: "sub_agency",
      seat_count: 1,
      billing_period: "monthly",
    }, PRICING);
    expect(cents).toBe(24900n);
  });

  it("single-seat monthly Sub-Host Pro = $149.00", () => {
    expect(
      computeEffectiveMonthlyRevenue({
        tier_code: "sub_pro",
        seat_count: 1,
        billing_period: "monthly",
      }, PRICING),
    ).toBe(14900n);
  });

  it("single-seat monthly Sub-Host Starter = $49.00", () => {
    expect(
      computeEffectiveMonthlyRevenue({
        tier_code: "sub_starter",
        seat_count: 1,
        billing_period: "monthly",
      }, PRICING),
    ).toBe(4900n);
  });

  it("6-user annual Sub-Host Agency ≈ $436.67/mo (within $1)", () => {
    // §27.4.1 worked example: base $2490 annual + 3×$590 (seats 2-4) + 2×$490 (seats 5-6) = $5240/yr = $436.67/mo
    const cents = computeEffectiveMonthlyRevenue({
      tier_code: "sub_agency",
      seat_count: 6,
      billing_period: "annual",
    }, PRICING);
    // Integer floor: 524000 / 12 = 43666
    expect(Math.abs(Number(cents) - 43667)).toBeLessThanOrEqual(100);
  });

  it("4-user monthly Sub-Host Agency = base $249 + 3×$59 = $426 (per current ladder)", () => {
    // Per §3.3 spec: users 2-4 @ $59 → 3 add'l seats × $59 = $177; base $249.
    // Total = $426 = 42600 cents.
    const cents = computeEffectiveMonthlyRevenue({
      tier_code: "sub_agency",
      seat_count: 4,
      billing_period: "monthly",
    }, PRICING);
    expect(cents).toBe(42600n);
  });

  it("BYO Agency multi-seat monthly = base $99 + ladder", () => {
    // 6 users: $99 + 3×$59 + 2×$49 = $99 + $177 + $98 = $374
    const cents = computeEffectiveMonthlyRevenue({
      tier_code: "byo_agency",
      seat_count: 6,
      billing_period: "monthly",
    }, PRICING);
    expect(cents).toBe(37400n);
  });
});
