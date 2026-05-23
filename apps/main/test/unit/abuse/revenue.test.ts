// §27.4.1 / §3.3 — Revenue computation worked examples.

import { describe, it, expect } from "vitest";
import { computeEffectiveMonthlyRevenue } from "@/lib/abuse/revenue";

describe("computeEffectiveMonthlyRevenue", () => {
  it("single-seat monthly Sub-Host Agency = $249.00", () => {
    const cents = computeEffectiveMonthlyRevenue({
      tier_code: "sub_agency",
      seat_count: 1,
      billing_period: "monthly",
    });
    expect(cents).toBe(24900n);
  });

  it("single-seat monthly Sub-Host Pro = $149.00", () => {
    expect(
      computeEffectiveMonthlyRevenue({
        tier_code: "sub_pro",
        seat_count: 1,
        billing_period: "monthly",
      }),
    ).toBe(14900n);
  });

  it("single-seat monthly Sub-Host Starter = $49.00", () => {
    expect(
      computeEffectiveMonthlyRevenue({
        tier_code: "sub_starter",
        seat_count: 1,
        billing_period: "monthly",
      }),
    ).toBe(4900n);
  });

  it("6-user annual Sub-Host Agency ≈ $436.67/mo (within $1)", () => {
    // §27.4.1 worked example: base $2490 annual + 3×$590 (seats 2-4) + 2×$490 (seats 5-6) = $5240/yr = $436.67/mo
    const cents = computeEffectiveMonthlyRevenue({
      tier_code: "sub_agency",
      seat_count: 6,
      billing_period: "annual",
    });
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
    });
    expect(cents).toBe(42600n);
  });

  it("BYO Agency multi-seat monthly = base $99 + ladder", () => {
    // 6 users: $99 + 3×$59 + 2×$49 = $99 + $177 + $98 = $374
    const cents = computeEffectiveMonthlyRevenue({
      tier_code: "byo_agency",
      seat_count: 6,
      billing_period: "monthly",
    });
    expect(cents).toBe(37400n);
  });
});
