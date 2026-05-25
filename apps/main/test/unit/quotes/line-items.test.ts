// BP38 §38.5 — line-item validation tests.

import { describe, expect, it } from "vitest";
import { validateLineItems, type LineItem } from "@/lib/quotes/line-items";

const baseItems: LineItem[] = [
  { description: "Base fare", amount_cents: 200000, is_commissionable: true, category: "base_fare" },
  { description: "Beverage package", amount_cents: 50000, is_commissionable: true, category: "beverage_package" },
  { description: "Taxes & port fees", amount_cents: 30000, is_commissionable: false, category: "taxes_fees" },
];

describe("validateLineItems", () => {
  it("accepts a clean breakdown", () => {
    const r = validateLineItems(baseItems, {
      total_amount_cents: 280000,
      commissionable_fare_cents: 250000,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects sum mismatch beyond tolerance", () => {
    const r = validateLineItems(baseItems, {
      total_amount_cents: 300000, // off by $200
      commissionable_fare_cents: 250000,
    });
    expect(r.ok).toBe(false);
  });

  it("accepts sum mismatch within $1 tolerance", () => {
    const r = validateLineItems(baseItems, {
      total_amount_cents: 280050, // off by $0.50 — within tolerance
      commissionable_fare_cents: 250000,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects unknown category", () => {
    const r = validateLineItems(
      [{ description: "x", amount_cents: 100, is_commissionable: true, category: "made_up" as never }],
      { total_amount_cents: 100, commissionable_fare_cents: 100 },
    );
    expect(r.ok).toBe(false);
  });

  it("rejects commissionable mismatch", () => {
    const r = validateLineItems(baseItems, {
      total_amount_cents: 280000,
      commissionable_fare_cents: 300000, // doesn't match sum-of-commissionable
    });
    expect(r.ok).toBe(false);
  });

  it("rejects empty descriptions", () => {
    const r = validateLineItems(
      [{ description: "", amount_cents: 100, is_commissionable: true, category: "base_fare" }],
      { total_amount_cents: 100, commissionable_fare_cents: 100 },
    );
    expect(r.ok).toBe(false);
  });
});
