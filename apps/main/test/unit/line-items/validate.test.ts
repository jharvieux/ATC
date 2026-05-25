// BP40 §40.3 / §40.9 — line-item validation tests.

import { describe, expect, it } from "vitest";
import { computeExpectedCommissionCents, validateLineItem } from "@/lib/line-items/validate";

describe("validateLineItem", () => {
  it("rejects start > end on dates", () => {
    const r = validateLineItem({
      item_type: "hotel",
      start_date: "2026-05-10",
      end_date: "2026-05-08",
      item_details: { hotel_name: "x" },
    });
    expect(r.ok).toBe(false);
  });

  it("excursion requires same start/end day", () => {
    const r = validateLineItem({
      item_type: "excursion",
      start_date: "2026-05-10",
      end_date: "2026-05-11",
      item_details: null,
    });
    expect(r.ok).toBe(false);
  });

  it("flight requires depart_airport + arrive_airport", () => {
    const r = validateLineItem({
      item_type: "flight",
      start_date: null,
      end_date: null,
      item_details: { depart_airport: "LAX" }, // missing arrive
    });
    expect(r.ok).toBe(false);
  });

  it("hotel requires hotel_name + at-least-1-night between dates", () => {
    const r = validateLineItem({
      item_type: "hotel",
      start_date: "2026-05-10",
      end_date: "2026-05-10", // 0 nights
      item_details: { hotel_name: "Hyatt" },
    });
    expect(r.ok).toBe(false);
  });

  it("accepts a clean flight", () => {
    const r = validateLineItem({
      item_type: "flight",
      start_date: "2026-03-14",
      end_date: "2026-03-14",
      item_details: { depart_airport: "LAX", arrive_airport: "FLL" },
    });
    expect(r.ok).toBe(true);
  });

  it("transfer + other + insurance pass with minimal data", () => {
    for (const t of ["transfer", "insurance", "other"] as const) {
      const r = validateLineItem({
        item_type: t,
        start_date: null,
        end_date: null,
        item_details: null,
      });
      expect(r.ok).toBe(true);
    }
  });
});

describe("computeExpectedCommissionCents", () => {
  it("returns null when not commissionable", () => {
    expect(
      computeExpectedCommissionCents({ commissionable: false, customer_cost_cents: 100000, commission_rate: 0.1 }),
    ).toBeNull();
  });

  it("returns null when commission_rate is null", () => {
    expect(
      computeExpectedCommissionCents({ commissionable: true, customer_cost_cents: 100000, commission_rate: null }),
    ).toBeNull();
  });

  it("computes integer cents (half-away-from-zero rounding)", () => {
    expect(
      computeExpectedCommissionCents({ commissionable: true, customer_cost_cents: 123456, commission_rate: 0.075 }),
    ).toBe(Math.round(123456 * 0.075));
  });
});
