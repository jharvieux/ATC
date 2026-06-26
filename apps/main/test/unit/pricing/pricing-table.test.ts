// EPIC #1336, Phase 1 — loadPricingTable is the DB-backed single source of
// truth for subscription pricing. These tests encode the WHY:
//   1. DB values must actually flow through (not the hardcoded fallback) — so a
//      regression that reverts to TIER_BASE_PRICE_CENTS fails here.
//   2. A read failure or unseeded DB must degrade to PRICING_FALLBACK, never
//      throw — pricing display + abuse-revenue math must not hard-fail.
//   3. The open-ended seat-ladder band must work when its up_to_seat is the
//      INT4-max DB sentinel (2147483647), not just the Infinity fallback —
//      guards the calculateAgencySeatPreviewCents / ladderTotalCents walk.

import { describe, it, expect, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadPricingTable,
  tierMonthlyPriceCents,
  PRICING_FALLBACK,
  _resetPricingCacheForTests,
} from "@/lib/pricing/pricing-table";
import { computeEffectiveMonthlyRevenue } from "@/lib/abuse/revenue";
import { calculateAgencySeatPreviewCents } from "@/lib/stripe/price-ids";

type Result = { data: unknown; error: { message: string } | null };

// Chain is itself thenable: `await db.from(t).select(...)` and
// `await db.from(t).select(...).order(...)` both resolve to the table's Result.
function pricingDb(byTable: Record<string, Result>): SupabaseClient {
  const makeChain = (table: string) => {
    const result = byTable[table] ?? { data: [], error: null };
    const chain = {
      select: () => chain,
      order: () => chain,
      eq: () => chain,
      then: (resolve: (r: Result) => unknown) => resolve(result),
    };
    return chain;
  };
  return { from: (table: string) => makeChain(table) } as unknown as SupabaseClient;
}

beforeEach(() => {
  _resetPricingCacheForTests();
});

describe("loadPricingTable", () => {
  it("returns DB values, not the code fallback (single source of truth)", async () => {
    // Deliberately different from PRICING_FALLBACK so a revert-to-constant fails.
    const db = pricingDb({
      tier_definitions: {
        data: [{ code: "byo_research", base_price_monthly_cents: 2500, base_price_annual_cents: 25000 }],
        error: null,
      },
      pricing_seat_ladder: {
        data: [{ up_to_seat: 2147483647, monthly_cents: 7000, annual_cents: 70000 }],
        error: null,
      },
    });
    const pricing = await loadPricingTable(db);
    expect(pricing.base.byo_research).toEqual({ monthly: 2500, annual: 25000 });
    expect(pricing.seatLadder).toEqual([{ upTo: 2147483647, monthly: 7000, annual: 70000 }]);
    // Tiers absent from the DB rows fall back so every tier is always present.
    expect(pricing.base.sub_pro).toEqual(PRICING_FALLBACK.base.sub_pro);
  });

  it("degrades to PRICING_FALLBACK on a read error (never throws)", async () => {
    const db = pricingDb({
      tier_definitions: { data: null, error: { message: "connection reset" } },
      pricing_seat_ladder: { data: [], error: null },
    });
    const pricing = await loadPricingTable(db);
    expect(pricing).toEqual(PRICING_FALLBACK);
  });

  it("falls back to the code ladder when the ladder table is unseeded", async () => {
    const db = pricingDb({
      tier_definitions: {
        data: [{ code: "sub_pro", base_price_monthly_cents: 14900, base_price_annual_cents: 149000 }],
        error: null,
      },
      pricing_seat_ladder: { data: [], error: null },
    });
    const pricing = await loadPricingTable(db);
    expect(pricing.seatLadder).toEqual(PRICING_FALLBACK.seatLadder);
  });

  it("caches within the TTL (second call does not re-read)", async () => {
    let reads = 0;
    const counting = {
      from: (table: string) => {
        const result: Result =
          table === "tier_definitions"
            ? { data: [{ code: "sub_pro", base_price_monthly_cents: 11111, base_price_annual_cents: 111110 }], error: null }
            : { data: [], error: null };
        const chain = {
          select: () => { reads++; return chain; },
          order: () => chain,
          eq: () => chain,
          then: (resolve: (r: Result) => unknown) => resolve(result),
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    const first = await loadPricingTable(counting);
    const readsAfterFirst = reads;
    const second = await loadPricingTable(counting);
    expect(second).toBe(first); // same cached object
    expect(reads).toBe(readsAfterFirst); // no further reads
  });
});

describe("DB pricing flows into the compute functions", () => {
  it("computeEffectiveMonthlyRevenue uses the injected (DB) table", async () => {
    const db = pricingDb({
      tier_definitions: {
        data: [{ code: "sub_pro", base_price_monthly_cents: 20000, base_price_annual_cents: 200000 }],
        error: null,
      },
      pricing_seat_ladder: { data: [], error: null },
    });
    const pricing = await loadPricingTable(db);
    const cents = computeEffectiveMonthlyRevenue(
      { tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
      pricing,
    );
    expect(cents).toBe(20000n); // DB value, not the 14900 fallback
  });
});

describe("tierMonthlyPriceCents — period-aware plan price (dashboard #1332)", () => {
  it("returns the monthly base under monthly billing", () => {
    expect(tierMonthlyPriceCents({ monthly: 14900, annual: 149000 }, "monthly")).toBe(14900);
  });
  it("returns the monthly-equivalent (annual / 12, rounded) under annual billing", () => {
    // 149000 / 12 = 12416.67 → 12417, so a "$X/mo" card is honest for annual plans.
    expect(tierMonthlyPriceCents({ monthly: 14900, annual: 149000 }, "annual")).toBe(Math.round(149000 / 12));
  });
  it("treats a null/unknown billing period as monthly", () => {
    expect(tierMonthlyPriceCents({ monthly: 4900, annual: 49000 }, null)).toBe(4900);
  });
});

describe("seat ladder uses the open-ended band correctly under the DB sentinel", () => {
  it("prices seats past the last finite band via the 2147483647 sentinel", () => {
    // DB-shaped ladder: bands 2-4 @ $59, 5-10 @ $49, 11+ @ $39 (sentinel upTo).
    const ladder = [
      { upTo: 4, monthly: 5900, annual: 59000 },
      { upTo: 10, monthly: 4900, annual: 49000 },
      { upTo: 2147483647, monthly: 3900, annual: 39000 },
    ];
    // 14 total seats → 13 additional: seats 2-4 (3 @ 5900) + 5-10 (6 @ 4900) + 11-14 (4 @ 3900).
    const expected = 3 * 5900 + 6 * 4900 + 4 * 3900;
    expect(calculateAgencySeatPreviewCents(13, "monthly", ladder)).toBe(expected);
  });
});
