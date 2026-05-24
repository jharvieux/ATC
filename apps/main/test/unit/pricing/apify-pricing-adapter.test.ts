// BP34 §33.3 — ApifyPricingAdapter unit tests.
//
// All assertions are against the guard behaviour, never the live Apify
// service. Real-actor verification lives in a separate integration script
// that is gated behind RUN_APIFY_LIVE=1 (not part of CI).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────
const alertCalls: unknown[] = [];
vi.mock("@/lib/monitoring/send-operator-alert", () => ({
  sendOperatorAlert: vi.fn(async (input: unknown) => {
    alertCalls.push(input);
  }),
}));

import { ApifyPricingAdapter } from "../../../src/lib/pricing/apify-pricing-adapter";
import type { SailingKey } from "../../../src/lib/pricing/types";

// ── Test doubles ───────────────────────────────────────────────────────────

interface InsertRecord {
  table: string;
  rows: unknown[];
}

interface MockDb {
  from: (t: string) => unknown;
  _inserts: InsertRecord[];
  _upserts: InsertRecord[];
}

function makeMockDb(opts: { monthlySpend?: number } = {}): MockDb {
  const inserts: InsertRecord[] = [];
  const upserts: InsertRecord[] = [];
  const monthlySpend = opts.monthlySpend ?? 0;

  const db = {
    from(table: string) {
      const builder = {
        async insert(rows: unknown) {
          inserts.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
          return { data: null, error: null };
        },
        async upsert(rows: unknown) {
          upserts.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
          return { data: null, error: null };
        },
        select() {
          const chain = {
            eq() { return chain; },
            gte() { return chain; },
            then(resolve: (v: { data: unknown[] }) => unknown) {
              if (table === "apify_spend_ledger") {
                return resolve({ data: monthlySpend > 0 ? [{ spend_usd: monthlySpend }] : [] });
              }
              return resolve({ data: [] });
            },
          };
          return chain;
        },
      };
      return builder;
    },
    _inserts: inserts,
    _upserts: upserts,
  };
  return db as unknown as MockDb;
}

const SAILING: SailingKey = {
  line: "RCL",
  ship: "symphony-of-the-seas",
  sailDate: "2026-08-15",
  departurePort: "MIA",
  durationNights: 7,
};

// ── Setup ──────────────────────────────────────────────────────────────────

const originalEnv = { ...process.env };
beforeEach(() => {
  alertCalls.length = 0;
  // Reset env to a known baseline (adapter OFF, no token).
  delete process.env.APIFY_ADAPTER_ENABLED;
  delete process.env.APIFY_API_TOKEN;
  delete process.env.APIFY_RUN_BUDGET_USD_CEILING;
  delete process.env.APIFY_MONTHLY_BUDGET_USD_CEILING;
});
afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ApifyPricingAdapter — guards", () => {
  it("refuses when APIFY_ADAPTER_ENABLED is not 'true' (default cost-deferral)", async () => {
    const db = makeMockDb();
    const adapter = new ApifyPricingAdapter(db as never);
    const r = await adapter.refreshTrackedSailings([SAILING]);
    expect(r.partial).toBe(true);
    expect(r.reason).toMatch(/adapter_disabled/);
    expect(r.spend_usd).toBe(0);
    expect(r.actor_run_id).toBeNull();
  });

  it("refuses when token missing even if enabled", async () => {
    process.env.APIFY_ADAPTER_ENABLED = "true";
    const db = makeMockDb();
    const adapter = new ApifyPricingAdapter(db as never);
    const r = await adapter.refreshTrackedSailings([SAILING]);
    expect(r.reason).toMatch(/no_api_token/);
  });

  it("refuses + emits operator alert when monthly cap is exhausted", async () => {
    process.env.APIFY_ADAPTER_ENABLED = "true";
    process.env.APIFY_API_TOKEN = "test-token";
    process.env.APIFY_MONTHLY_BUDGET_USD_CEILING = "100";
    const db = makeMockDb({ monthlySpend: 150 });
    const adapter = new ApifyPricingAdapter(db as never);
    const r = await adapter.refreshTrackedSailings([SAILING]);
    expect(r.reason).toMatch(/monthly_budget_exhausted/);
    expect(alertCalls).toHaveLength(1);
  });
});

describe("ApifyPricingAdapter — getCachedPrice", () => {
  it("returns 'unsupported' for lines with no enabled route, regardless of kill switch", async () => {
    // BCK aggregator and feature-flagged lines all return unsupported.
    const db = makeMockDb();
    const adapter = new ApifyPricingAdapter(db as never);
    const r = await adapter.getCachedPrice({ ...SAILING, line: "BCK" });
    expect(r.status).toBe("unsupported");
  });

  it("returns 'miss' when route exists but no cached rows", async () => {
    const db = makeMockDb();
    const adapter = new ApifyPricingAdapter(db as never);
    const r = await adapter.getCachedPrice(SAILING);
    expect(r.status).toBe("miss");
  });
});

describe("ApifyPricingAdapter — per-run cost cap", () => {
  it("aborts and logs an estimated_skipped ledger row when per-run estimate > cap", async () => {
    process.env.APIFY_ADAPTER_ENABLED = "true";
    process.env.APIFY_API_TOKEN = "test-token";
    process.env.APIFY_RUN_BUDGET_USD_CEILING = "1"; // estimate is 50 * 0.05 = $2.50, > $1

    const db = makeMockDb();
    const adapter = new ApifyPricingAdapter(db as never);
    const r = await adapter.refreshTrackedSailings([SAILING]);
    expect(r.reason).toMatch(/per_run_estimate_over_cap/);

    const ledger = db._inserts.find((i: InsertRecord) => i.table === "apify_spend_ledger");
    expect(ledger).toBeDefined();
    expect((ledger!.rows[0] as Record<string, unknown>).status).toBe("estimated_skipped");
  });
});
