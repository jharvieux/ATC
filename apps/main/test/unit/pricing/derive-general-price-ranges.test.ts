// #828b — derive ballpark general_pricing_ranges from interior lead-ins.
//
// The pure core (deriveRangesFromLeadIns) is the business logic: aggregate
// observed interior "from $X" prices into a min/max range per (line, ship,
// duration), then scale each cabin tier by its multiplier. Tests pin the WHY:
// a bad lead-in must not poison a group; high >= low (the DB CHECK); the tier
// multipliers match #828. The runner tests pin the D-091 mutation/read checks.

import { describe, it, expect } from "vitest";
import {
  deriveRangesFromLeadIns,
  runDeriveGeneralPriceRanges,
  CABIN_MULTIPLIERS,
  type InteriorLeadIn,
} from "../../../src/lib/pricing/derive-general-price-ranges";

describe("deriveRangesFromLeadIns", () => {
  it("aggregates interior lead-ins to min/max and scales each cabin tier", () => {
    const rows = deriveRangesFromLeadIns([
      { cruise_line: "Norwegian Cruise Line", ship: "Norwegian Prima", duration_nights: 7, price_amount: 1000 },
      { cruise_line: "Norwegian Cruise Line", ship: "Norwegian Prima", duration_nights: 7, price_amount: 1500 },
    ]);
    const byCabin = Object.fromEntries(rows.map((r) => [r.cabin_class, r]));
    expect(byCabin.interior).toMatchObject({ low_amount: 1000, high_amount: 1500 });
    expect(byCabin.oceanview).toMatchObject({ low_amount: 1300, high_amount: 1950 });
    expect(byCabin.balcony).toMatchObject({ low_amount: 1600, high_amount: 2400 });
    expect(byCabin.mini_suite).toMatchObject({ low_amount: 2200, high_amount: 3300 });
    expect(byCabin.suite).toMatchObject({ low_amount: 3000, high_amount: 4500 });
    expect(rows).toHaveLength(5); // one set of 5 cabins for the one group
  });

  it("emits a separate set of 5 rows per (line, ship, duration) group", () => {
    const rows = deriveRangesFromLeadIns([
      { cruise_line: "L", ship: "S", duration_nights: 7, price_amount: 800 },
      { cruise_line: "L", ship: "S", duration_nights: 14, price_amount: 1600 }, // different duration → own group
    ]);
    expect(rows).toHaveLength(10);
    const seven = rows.find((r) => r.duration_nights === 7 && r.cabin_class === "interior");
    expect(seven).toMatchObject({ low_amount: 800, high_amount: 800 });
  });

  it("keeps low == high for a single lead-in (degenerate point range)", () => {
    const rows = deriveRangesFromLeadIns([{ cruise_line: "L", ship: "S", duration_nights: 7, price_amount: 929 }]);
    const interior = rows.find((r) => r.cabin_class === "interior")!;
    expect(interior.low_amount).toBe(929);
    expect(interior.high_amount).toBe(929);
    const suite = rows.find((r) => r.cabin_class === "suite")!;
    expect(suite.low_amount).toBe(Math.round(929 * CABIN_MULTIPLIERS.suite));
  });

  it("skips non-positive prices and missing line/ship so a bad row can't poison a group", () => {
    const rows = deriveRangesFromLeadIns([
      { cruise_line: "L", ship: "S", duration_nights: 7, price_amount: 1000 },
      { cruise_line: "L", ship: "S", duration_nights: 7, price_amount: 0 }, // skipped
      { cruise_line: "L", ship: "S", duration_nights: 7, price_amount: -50 }, // skipped
      { cruise_line: "", ship: "S", duration_nights: 7, price_amount: 999 }, // skipped (no line)
    ]);
    const interior = rows.find((r) => r.cabin_class === "interior")!;
    // Only the valid 1000 lead-in counts — NOT dragged to 0 or -50.
    expect(interior).toMatchObject({ low_amount: 1000, high_amount: 1000 });
  });

  it("returns [] when there are no valid lead-ins", () => {
    expect(deriveRangesFromLeadIns([])).toEqual([]);
    expect(deriveRangesFromLeadIns([{ cruise_line: "L", ship: "S", duration_nights: 0, price_amount: 100 }])).toEqual([]);
  });

  it("always emits high_amount >= low_amount (satisfies the DB CHECK)", () => {
    const rows = deriveRangesFromLeadIns([
      { cruise_line: "L", ship: "S", duration_nights: 7, price_amount: 1234 },
      { cruise_line: "L", ship: "S", duration_nights: 7, price_amount: 2345 },
    ]);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.high_amount).toBeGreaterThanOrEqual(r.low_amount);
  });
});

// Thenable single-page select; upsert records rows + can simulate an error.
function makeDb(opts: { leadIns: InteriorLeadIn[]; selectError?: string; upsertError?: string }) {
  let served = false;
  const upsertCalls: Array<Array<Record<string, unknown>>> = [];
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          range: async () => {
            if (opts.selectError) return { data: null, error: { message: opts.selectError } };
            // Serve all lead-ins on the first page, then an empty page to stop.
            if (served) return { data: [], error: null };
            served = true;
            return {
              data: opts.leadIns.map((l) => ({
                cruise_line: l.cruise_line,
                ship: l.ship,
                duration_nights: l.duration_nights,
                price_amount: l.price_amount,
              })),
              error: null,
            };
          },
        }),
      }),
      upsert: async (rows: Array<Record<string, unknown>>) => {
        upsertCalls.push(rows);
        return { error: opts.upsertError ? { message: opts.upsertError } : null };
      },
    }),
  } as unknown as Parameters<typeof runDeriveGeneralPriceRanges>[0];
  return { db, upsertCalls };
}

describe("runDeriveGeneralPriceRanges", () => {
  it("upserts the derived rows tagged source='estimated'", async () => {
    const { db, upsertCalls } = makeDb({
      leadIns: [{ cruise_line: "L", ship: "S", duration_nights: 7, price_amount: 1000 }],
    });
    const res = await runDeriveGeneralPriceRanges(db);
    expect(res).toMatchObject({ lead_ins_read: 1, groups: 1, rows_upserted: 5 });
    const upserted = upsertCalls.flat();
    expect(upserted).toHaveLength(5);
    expect(upserted.every((r) => r.source === "estimated")).toBe(true);
  });

  it("throws when the pricing_cache read fails (D-091 — surface read failure)", async () => {
    const { db } = makeDb({ leadIns: [], selectError: "boom" });
    await expect(runDeriveGeneralPriceRanges(db)).rejects.toThrow(/pricing_cache.*failed/);
  });

  it("throws when the upsert fails (D-091 — surface mutation failure)", async () => {
    const { db } = makeDb({
      leadIns: [{ cruise_line: "L", ship: "S", duration_nights: 7, price_amount: 1000 }],
      upsertError: "nope",
    });
    await expect(runDeriveGeneralPriceRanges(db)).rejects.toThrow(/general_pricing_ranges.*failed/);
  });
});
