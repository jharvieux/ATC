// §33.3 — pricing_cache read/write unit tests.
//
// readPriceQuote: cache-miss, single-cabin, multi-cabin, staleness-driven
// freshnessFlag boundaries, string price_amount coercion (Postgres NUMERIC).
// upsertPriceQuote: row shaping, empty-cabinPrices no-op, safeAwait forwarding.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPriceQuote, upsertPriceQuote } from "@/lib/pricing/pricing-cache";
import type { SailingKey } from "@/lib/pricing/types";

// ── Env hygiene ─────────────────────────────────────────────────────────────

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

// ── safeAwait mock ───────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  safeAwait: vi.fn().mockResolvedValue(undefined),
  upsertCapture: vi.fn(),
}));

vi.mock("@/lib/db/safe-mutation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/safe-mutation")>(
    "@/lib/db/safe-mutation",
  );
  return { ...actual, safeAwait: mocks.safeAwait };
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.safeAwait.mockResolvedValue(undefined);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function sailing(over: Partial<SailingKey> = {}): SailingKey {
  return {
    line: "RCL",
    ship: "symphony-of-the-seas",
    sailDate: "2026-08-15",
    departurePort: "MIA",
    durationNights: 7,
    ...over,
  };
}

type Row = {
  cabin_class: string;
  price_amount: number | string;
  fetched_at: string;
  source: string;
};

function makeDb(rows: Row[]) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => Promise.resolve({ data: rows }),
              }),
            }),
          }),
        }),
      }),
      upsert: (r: unknown, opts?: unknown) => {
        mocks.upsertCapture(r, opts);
        return {};
      },
    }),
  };
}

// ── readPriceQuote — cache miss ───────────────────────────────────────────────

describe("readPriceQuote — cache miss", () => {
  it("returns null when no rows exist for the sailing key", async () => {
    const db = makeDb([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readPriceQuote(db as any, sailing());
    expect(result).toBeNull();
  });
});

// ── readPriceQuote — single cabin ────────────────────────────────────────────

describe("readPriceQuote — single cabin hit", () => {
  const FETCHED = "2026-08-14T10:00:00.000Z"; // ~30h ago = fresh (< 72h default)

  it("assembles a CachedPriceQuote from one row", async () => {
    const db = makeDb([
      { cabin_class: "balcony", price_amount: 2499, fetched_at: FETCHED, source: "apify" },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readPriceQuote(db as any, sailing());
    expect(result).not.toBeNull();
    expect(result!.key).toEqual(sailing());
    expect(result!.cabinPrices.balcony).toEqual({ amount: 2499, currency: "USD" });
    expect(result!.source).toBe("apify");
    expect(result!.fetchedAt.toISOString()).toBe(FETCHED);
  });

  it("coerces price_amount from string (Postgres NUMERIC arrives as string)", async () => {
    const db = makeDb([
      { cabin_class: "interior", price_amount: "1299.50", fetched_at: FETCHED, source: "apify" },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readPriceQuote(db as any, sailing());
    expect(result!.cabinPrices.interior!.amount).toBe(1299.5);
  });
});

// ── readPriceQuote — multi-cabin ─────────────────────────────────────────────

describe("readPriceQuote — multi-cabin", () => {
  it("populates cabinPrices for every cabin class returned", async () => {
    const FETCHED = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    const db = makeDb([
      { cabin_class: "interior",  price_amount: 1200, fetched_at: FETCHED, source: "apify" },
      { cabin_class: "oceanview", price_amount: 1600, fetched_at: FETCHED, source: "apify" },
      { cabin_class: "balcony",   price_amount: 2100, fetched_at: FETCHED, source: "apify" },
      { cabin_class: "suite",     price_amount: 4500, fetched_at: FETCHED, source: "apify" },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readPriceQuote(db as any, sailing());
    expect(Object.keys(result!.cabinPrices)).toHaveLength(4);
    expect(result!.cabinPrices.interior!.amount).toBe(1200);
    expect(result!.cabinPrices.suite!.amount).toBe(4500);
  });

  it("picks the latest fetched_at as fetchedAt and its source when rows differ", async () => {
    const OLDER = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
    const NEWER = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const db = makeDb([
      { cabin_class: "interior", price_amount: 1100, fetched_at: OLDER, source: "manual" },
      { cabin_class: "balcony",  price_amount: 2000, fetched_at: NEWER, source: "apify" },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readPriceQuote(db as any, sailing());
    expect(result!.source).toBe("apify"); // source from the newer row
    expect(result!.fetchedAt.toISOString()).toBe(NEWER);
  });
});

// ── readPriceQuote — freshnessFlag thresholds ────────────────────────────────

describe("readPriceQuote — freshnessFlag", () => {
  it("returns 'fresh' when staleness ≤ PRICE_FRESHNESS_FRESH_HOURS (default 72)", async () => {
    const FETCHED = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 24h ago
    const db = makeDb([{ cabin_class: "interior", price_amount: 1000, fetched_at: FETCHED, source: "apify" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readPriceQuote(db as any, sailing());
    expect(result!.freshnessFlag).toBe("fresh");
  });

  it("returns 'expired' when staleness ≥ PRICE_FRESHNESS_EXPIRED_HOURS (default 744)", async () => {
    const FETCHED = new Date(Date.now() - 750 * 60 * 60 * 1000).toISOString(); // 750h ago
    const db = makeDb([{ cabin_class: "interior", price_amount: 1000, fetched_at: FETCHED, source: "apify" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readPriceQuote(db as any, sailing());
    expect(result!.freshnessFlag).toBe("expired");
  });

  it("returns 'stale' in the gap between fresh and expired thresholds", async () => {
    const FETCHED = new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString(); // 200h ago
    const db = makeDb([{ cabin_class: "interior", price_amount: 1000, fetched_at: FETCHED, source: "apify" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readPriceQuote(db as any, sailing());
    expect(result!.freshnessFlag).toBe("stale");
  });

  it("respects PRICE_FRESHNESS_FRESH_HOURS override", async () => {
    process.env.PRICE_FRESHNESS_FRESH_HOURS = "10";
    const FETCHED = new Date(Date.now() - 15 * 60 * 60 * 1000).toISOString(); // 15h ago
    const db = makeDb([{ cabin_class: "interior", price_amount: 1000, fetched_at: FETCHED, source: "apify" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readPriceQuote(db as any, sailing());
    // 15h > 10h threshold → should NOT be fresh
    expect(result!.freshnessFlag).not.toBe("fresh");
  });

  it("respects PRICE_FRESHNESS_EXPIRED_HOURS override", async () => {
    process.env.PRICE_FRESHNESS_EXPIRED_HOURS = "100";
    const FETCHED = new Date(Date.now() - 110 * 60 * 60 * 1000).toISOString(); // 110h ago
    const db = makeDb([{ cabin_class: "interior", price_amount: 1000, fetched_at: FETCHED, source: "apify" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await readPriceQuote(db as any, sailing());
    // 110h > 100h expired threshold
    expect(result!.freshnessFlag).toBe("expired");
  });
});

// ── upsertPriceQuote ─────────────────────────────────────────────────────────

describe("upsertPriceQuote — no-op on empty cabinPrices", () => {
  it("returns without calling safeAwait when cabinPrices is empty", async () => {
    const db = makeDb([]);
    await upsertPriceQuote(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      {
        key: sailing(),
        cabinPrices: {},
        fetchedAt: new Date(),
        source: "apify",
      },
    );
    expect(mocks.safeAwait).not.toHaveBeenCalled();
  });
});

describe("upsertPriceQuote — row shaping", () => {
  it("produces one DB row per cabinPrices entry with correct shape", async () => {
    const fetchedAt = new Date("2026-08-14T12:00:00.000Z");
    const db = makeDb([]);
    await upsertPriceQuote(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      {
        key: sailing({ line: "NCL", ship: "breakaway" }),
        cabinPrices: {
          interior: { amount: 899, currency: "USD" },
          balcony:  { amount: 1499, currency: "USD" },
        },
        fetchedAt,
        source: "apify",
      },
    );
    // safeAwait was called with the upsert chain and the label
    expect(mocks.safeAwait).toHaveBeenCalledOnce();
    expect(mocks.safeAwait.mock.calls[0]![1]).toBe("pricing_cache.upsert");

    // Upsert must use the composite dedup key (prevents duplicate inserts on
    // concurrent refreshes — the UNIQUE constraint is the idempotency mechanism).
    expect(mocks.upsertCapture).toHaveBeenCalledOnce();
    const opts = mocks.upsertCapture.mock.calls[0]![1] as { onConflict?: string };
    expect(opts?.onConflict).toBe(
      "cruise_line,ship,sail_date,departure_port,duration_nights,cabin_class",
    );
    const rows = mocks.upsertCapture.mock.calls[0]![0] as unknown[];
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cruise_line: "NCL",
          ship: "breakaway",
          cabin_class: "interior",
          price_amount: 899,
          price_currency: "USD",
          source: "apify",
          fetched_at: fetchedAt.toISOString(),
        }),
        expect.objectContaining({
          cabin_class: "balcony",
          price_amount: 1499,
        }),
      ]),
    );
  });

  it("skips cabinPrices entries whose value is absent (sparse Partial)", async () => {
    const db = makeDb([]);
    // Only populate interior; balcony is simply absent from the object (not set to undefined).
    const cabinPrices: Parameters<typeof upsertPriceQuote>[1]["cabinPrices"] = {
      interior: { amount: 999, currency: "USD" },
    };
    await upsertPriceQuote(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      { key: sailing(), cabinPrices, fetchedAt: new Date(), source: "manual" },
    );
    const rows = mocks.upsertCapture.mock.calls[0]![0] as unknown[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cabin_class: "interior" });
  });
});
