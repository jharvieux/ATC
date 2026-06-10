// #828 — buildPricingAnchorsBlock: guidance-fallback + STATIC_PRICING_GUIDANCE snapshot.
//
// WHY these tests exist:
// 1. Snapshot: pins the customer-visible pricing guidance text so any prompt
//    change requires an explicit snapshot update + PR review.
// 2. Guidance-fallback: when entities are present but general_pricing_ranges
//    has no rows, the function must still inject the guidance block (with rule 6
//    — non-price questions must NOT deflect to the booking system). Without this,
//    the AI has no instruction and silently deflects itinerary questions.

import { describe, expect, it } from "vitest";
import {
  buildPricingAnchorsBlock,
  buildPricingGuidanceOnly,
} from "../../../src/lib/pricing/build-pricing-anchors-block";

// Build a mock Supabase client whose query chain is thenable with the given result.
function makeDb(rows: Record<string, unknown>[] | null, error?: { message: string }) {
  const chain = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: { data: typeof rows; error: typeof error | null }) => unknown) =>
          Promise.resolve(resolve({ data: rows, error: error ?? null }));
      }
      return () => chain;
    },
  });
  return { from: () => chain } as never;
}

describe("buildPricingGuidanceOnly — snapshot", () => {
  it("returns the static pricing guidance (snapshot pins prompt text)", () => {
    // Any change to the customer-facing pricing guidance requires updating this
    // snapshot and explicitly reviewing the prompt diff.
    expect(buildPricingGuidanceOnly()).toMatchSnapshot();
  });

  it("scopes booking-system deferral to price-only questions", () => {
    const text = buildPricingGuidanceOnly();
    expect(text).toContain("NON-price questions");
    expect(text).toContain("do NOT deflect to the booking system");
  });

  it("returns empty when AI_PRICE_ROUNDING_ENABLED=false", () => {
    process.env.AI_PRICE_ROUNDING_ENABLED = "false";
    try {
      expect(buildPricingGuidanceOnly()).toBe("");
    } finally {
      delete process.env.AI_PRICE_ROUNDING_ENABLED;
    }
  });
});

describe("buildPricingAnchorsBlock — guidance fallback (#828)", () => {
  it("returns guidance-only (not empty) when entities present but DB has no rows", async () => {
    const db = makeDb([]);
    const result = await buildPricingAnchorsBlock(db, {
      cruiseLines: ["Royal Caribbean"],
      ships: [],
    });
    // Must not be empty — rule 6 needs to reach the model even when there are no
    // anchors, otherwise itinerary questions get deflected to the booking system.
    expect(result).not.toBe("");
    expect(result).toBe(buildPricingGuidanceOnly());
    expect(result).toContain("NON-price questions");
  });

  it("returns guidance-only when DB returns an error", async () => {
    const db = makeDb(null, { message: "connection refused" });
    const result = await buildPricingAnchorsBlock(db, {
      cruiseLines: ["Celebrity Cruises"],
      ships: [],
    });
    expect(result).toBe(buildPricingGuidanceOnly());
  });

  it("returns empty when there are no entities (no cruise lines, no ships)", async () => {
    const db = makeDb([]);
    const result = await buildPricingAnchorsBlock(db, {
      cruiseLines: [],
      ships: [],
    });
    // No entities → no pricing context needed → skip the block entirely.
    expect(result).toBe("");
  });

  it("returns guidance + PRICING ANCHORS section when rows exist", async () => {
    const db = makeDb([
      {
        cruise_line: "Royal Caribbean",
        ship: "Symphony of the Seas",
        cabin_class: "interior",
        duration_nights: 7,
        low_amount: 800,
        high_amount: 1200,
        source_url: null,
        fetched_at: "2026-05-01T00:00:00Z",
      },
    ]);
    const result = await buildPricingAnchorsBlock(db, {
      cruiseLines: ["Royal Caribbean"],
      ships: [],
    });
    expect(result).toContain("PRICING ANCHORS (available for this turn):");
    expect(result).toContain("Royal Caribbean");
    expect(result).toContain("Symphony of the Seas");
    // Guidance rules are also present
    expect(result).toContain("NON-price questions");
  });
});
