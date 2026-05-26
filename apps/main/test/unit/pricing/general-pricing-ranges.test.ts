// §33.4 D-088 — general_pricing_ranges storage helper tests.

import { describe, expect, it, vi } from "vitest";
import {
  upsertGeneralPriceRange,
  readShipPriceRanges,
  readPriceRange,
} from "../../../src/lib/pricing/general-pricing-ranges";

function makeMockDb(opts: {
  upsertError?: string;
  rangeRows?: Array<Record<string, unknown>>;
}) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const fromCall = (table: string) => {
    return {
      upsert(values: unknown, options?: unknown) {
        calls.push({ op: `upsert:${table}`, args: [values, options] });
        return Promise.resolve(
          opts.upsertError ? { error: { message: opts.upsertError } } : { error: null },
        );
      },
      select() {
        const chain = {
          eq() { return chain; },
          order() { return chain; },
          limit() { return chain; },
          async maybeSingle() {
            const row = opts.rangeRows?.[0] ?? null;
            return { data: row, error: null };
          },
          then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
            return resolve({ data: opts.rangeRows ?? [], error: null });
          },
        };
        return chain;
      },
    };
  };
  return { from: fromCall, _calls: calls } as never;
}

describe("upsertGeneralPriceRange", () => {
  it("calls upsert with the expected row + conflict target", async () => {
    const db = makeMockDb({});
    const res = await upsertGeneralPriceRange(db, {
      cruise_line: "Royal Caribbean",
      ship: "Symphony of the Seas",
      cabin_class: "balcony",
      duration_nights: 7,
      low_amount: 1200,
      high_amount: 3500,
      source_url: "https://cruisemapper.com/ships/sots",
    });
    expect(res.ok).toBe(true);
    const call = (db as never as { _calls: Array<{ op: string; args: unknown[] }> })._calls[0];
    expect(call?.op).toBe("upsert:general_pricing_ranges");
    const row = call?.args[0] as Record<string, unknown>;
    expect(row.cruise_line).toBe("Royal Caribbean");
    expect(row.ship).toBe("Symphony of the Seas");
    expect(row.cabin_class).toBe("balcony");
    expect(row.duration_nights).toBe(7);
    expect(row.low_amount).toBe(1200);
    expect(row.high_amount).toBe(3500);
    expect(row.currency).toBe("USD");
    expect(row.source).toBe("diy_cruisemapper");
    const options = call?.args[1] as Record<string, unknown>;
    expect(options.onConflict).toBe("cruise_line,ship,cabin_class,duration_nights,source");
  });

  it("propagates DB errors", async () => {
    const db = makeMockDb({ upsertError: "unique_violation" });
    const res = await upsertGeneralPriceRange(db, {
      cruise_line: "RCL",
      ship: "ship",
      cabin_class: "interior",
      duration_nights: 7,
      low_amount: 500,
      high_amount: 900,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unique_violation");
  });

  it("defaults source_url to null when omitted", async () => {
    const db = makeMockDb({});
    await upsertGeneralPriceRange(db, {
      cruise_line: "RCL",
      ship: "ship",
      cabin_class: "interior",
      duration_nights: 7,
      low_amount: 500,
      high_amount: 900,
    });
    const calls = (db as never as { _calls: Array<{ args: unknown[] }> })._calls;
    const row = calls[0]?.args[0] as Record<string, unknown>;
    expect(row.source_url).toBeNull();
  });
});

describe("readShipPriceRanges + readPriceRange", () => {
  it("coerces NUMERIC strings to numbers for low/high amounts", async () => {
    const db = makeMockDb({
      rangeRows: [
        {
          cruise_line: "RCL",
          ship: "Symphony",
          cabin_class: "balcony",
          duration_nights: 7,
          low_amount: "1200.00",
          high_amount: "3500.00",
          currency: "USD",
          source: "diy_cruisemapper",
          source_url: "https://example.com",
          fetched_at: "2026-05-26T12:00:00Z",
        },
      ],
    });
    const ranges = await readShipPriceRanges(db, "RCL", "Symphony");
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.low_amount).toBe(1200);
    expect(ranges[0]?.high_amount).toBe(3500);
    expect(typeof ranges[0]?.low_amount).toBe("number");
  });

  it("readPriceRange returns null when no row", async () => {
    const db = makeMockDb({ rangeRows: [] });
    const r = await readPriceRange(db, "RCL", "GhostShip", "balcony", 7);
    expect(r).toBeNull();
  });

  it("readPriceRange parses fetched_at as a Date", async () => {
    const db = makeMockDb({
      rangeRows: [
        {
          cruise_line: "RCL",
          ship: "Symphony",
          cabin_class: "balcony",
          duration_nights: 7,
          low_amount: 1200,
          high_amount: 3500,
          currency: "USD",
          source: "diy_cruisemapper",
          source_url: null,
          fetched_at: "2026-05-26T12:00:00Z",
        },
      ],
    });
    const r = await readPriceRange(db, "RCL", "Symphony", "balcony", 7);
    expect(r?.fetched_at).toBeInstanceOf(Date);
    expect(r?.source_url).toBeNull();
  });
});
