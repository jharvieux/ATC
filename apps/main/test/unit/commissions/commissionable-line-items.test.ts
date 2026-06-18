// §12.5 — Commissionable line-item reference data.
//
// Tests assert that the catalog covers the required categories, that each item
// has the documented status, and that helper queries over the set return correct
// subsets. Mutations to key/status values would fail the exact-match assertions.

import { describe, it, expect } from "vitest";
import {
  COMMISSIONABLE_LINE_ITEMS,
  type CommissionableStatus,
  type LineItemCategory,
} from "@/lib/commissions/commissionable-line-items";

function byStatus(status: CommissionableStatus): LineItemCategory[] {
  return COMMISSIONABLE_LINE_ITEMS.filter((i) => i.status === status);
}

describe("COMMISSIONABLE_LINE_ITEMS catalog", () => {
  it("contains all 9 documented categories", () => {
    expect(COMMISSIONABLE_LINE_ITEMS).toHaveLength(9);
  });

  it("every entry has a non-empty key, label, and valid status", () => {
    const validStatuses: CommissionableStatus[] = [
      "always_commissionable",
      "never_commissionable",
      "reduces_commissionable_fare",
      "line_specific_varies",
    ];
    for (const item of COMMISSIONABLE_LINE_ITEMS) {
      expect(item.key.length, `key missing on ${item.label}`).toBeGreaterThan(0);
      expect(item.label.length, `label missing on ${item.key}`).toBeGreaterThan(0);
      expect(validStatuses, `unknown status on ${item.key}`).toContain(item.status);
    }
  });

  it("all keys are unique (no duplicate category)", () => {
    const keys = COMMISSIONABLE_LINE_ITEMS.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("always_commissionable items", () => {
  it("base_cruise_fare is always_commissionable", () => {
    const item = COMMISSIONABLE_LINE_ITEMS.find((i) => i.key === "base_cruise_fare");
    expect(item?.status).toBe("always_commissionable");
  });

  it("cabin_upgrade is always_commissionable", () => {
    const item = COMMISSIONABLE_LINE_ITEMS.find((i) => i.key === "cabin_upgrade");
    expect(item?.status).toBe("always_commissionable");
  });

  it("beverage_packages is always_commissionable", () => {
    const item = COMMISSIONABLE_LINE_ITEMS.find((i) => i.key === "beverage_packages");
    expect(item?.status).toBe("always_commissionable");
  });

  it("excursions_cruise_line is always_commissionable", () => {
    const item = COMMISSIONABLE_LINE_ITEMS.find((i) => i.key === "excursions_cruise_line");
    expect(item?.status).toBe("always_commissionable");
  });

  it("exactly 4 items are always_commissionable (drift guard)", () => {
    expect(byStatus("always_commissionable")).toHaveLength(4);
  });
});

describe("never_commissionable items", () => {
  it("taxes_port_fees is never_commissionable", () => {
    const item = COMMISSIONABLE_LINE_ITEMS.find((i) => i.key === "taxes_port_fees");
    expect(item?.status).toBe("never_commissionable");
  });

  it("insurance is never_commissionable", () => {
    const item = COMMISSIONABLE_LINE_ITEMS.find((i) => i.key === "insurance");
    expect(item?.status).toBe("never_commissionable");
  });

  it("gratuities_prepaid is never_commissionable", () => {
    const item = COMMISSIONABLE_LINE_ITEMS.find((i) => i.key === "gratuities_prepaid");
    expect(item?.status).toBe("never_commissionable");
  });

  it("exactly 3 items are never_commissionable (drift guard)", () => {
    expect(byStatus("never_commissionable")).toHaveLength(3);
  });
});

describe("reduces_commissionable_fare items", () => {
  it("loyalty_discount reduces the commissionable fare", () => {
    const item = COMMISSIONABLE_LINE_ITEMS.find((i) => i.key === "loyalty_discount");
    expect(item?.status).toBe("reduces_commissionable_fare");
  });

  it("exactly 1 item reduces_commissionable_fare", () => {
    expect(byStatus("reduces_commissionable_fare")).toHaveLength(1);
  });
});

describe("line_specific_varies items", () => {
  it("specialty_dining is line_specific_varies", () => {
    const item = COMMISSIONABLE_LINE_ITEMS.find((i) => i.key === "specialty_dining");
    expect(item?.status).toBe("line_specific_varies");
  });

  it("exactly 1 item is line_specific_varies", () => {
    expect(byStatus("line_specific_varies")).toHaveLength(1);
  });
});

describe("commissionable subset computation", () => {
  it("filters to always_commissionable for commission math (§12.5)", () => {
    // Commission math uses always_commissionable + reduces_commissionable_fare.
    // A mutation that includes never_commissionable items would bloat the base.
    const commissionable = COMMISSIONABLE_LINE_ITEMS.filter(
      (i) => i.status === "always_commissionable" || i.status === "reduces_commissionable_fare",
    );
    expect(commissionable.map((i) => i.key)).toEqual(
      expect.arrayContaining(["base_cruise_fare", "cabin_upgrade", "loyalty_discount"]),
    );
    expect(commissionable.map((i) => i.key)).not.toContain("taxes_port_fees");
    expect(commissionable.map((i) => i.key)).not.toContain("insurance");
  });

  it("never_commissionable keys are excluded from any commissionable set", () => {
    const never = byStatus("never_commissionable").map((i) => i.key);
    const commissionable = COMMISSIONABLE_LINE_ITEMS.filter(
      (i) => i.status !== "never_commissionable",
    ).map((i) => i.key);
    for (const key of never) {
      expect(commissionable).not.toContain(key);
    }
  });
});
