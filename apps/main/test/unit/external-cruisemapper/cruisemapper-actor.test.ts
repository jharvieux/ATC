// BP35 §33.4 — CruiseMapper actor wrapper guard tests.
//
// Three guard fences must short-circuit before any real fetch:
//   1. CRUISEMAPPER_ITINERARY_INGEST_ENABLED=true
//   2. APIFY_ADAPTER_ENABLED=true
//   3. APIFY_API_TOKEN set
// Plus the shared monthly budget cap from BP34.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const alertCalls: unknown[] = [];
vi.mock("@/lib/monitoring/send-operator-alert", () => ({
  sendOperatorAlert: vi.fn(async (input: unknown) => {
    alertCalls.push(input);
  }),
}));

import { runCruiseMapperItineraryActor } from "../../../src/lib/external/cruisemapper/cruisemapper-actor";

interface InsertRecord { table: string; rows: unknown[] }
interface MockDb { from: (t: string) => unknown; _inserts: InsertRecord[] }

function makeMockDb(opts: { monthlySpend?: number } = {}): MockDb {
  const inserts: InsertRecord[] = [];
  const monthlySpend = opts.monthlySpend ?? 0;
  return {
    from(table: string) {
      return {
        async insert(rows: unknown) {
          inserts.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
          return { data: null, error: null };
        },
        select() {
          const chain = {
            gte() { return chain; },
            then(resolve: (v: { data: unknown[] }) => unknown) {
              if (table === "apify_spend_ledger" && monthlySpend > 0) {
                return resolve({ data: [{ spend_usd: monthlySpend }] });
              }
              return resolve({ data: [] });
            },
          };
          return chain;
        },
      };
    },
    _inserts: inserts,
  };
}

const originalEnv = { ...process.env };
beforeEach(() => {
  alertCalls.length = 0;
  delete process.env.CRUISEMAPPER_ITINERARY_INGEST_ENABLED;
  delete process.env.APIFY_ADAPTER_ENABLED;
  delete process.env.APIFY_API_TOKEN;
  delete process.env.APIFY_MONTHLY_BUDGET_USD_CEILING;
});
afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("runCruiseMapperItineraryActor — guards", () => {
  it("skips when CRUISEMAPPER_ITINERARY_INGEST_ENABLED is not 'true'", async () => {
    const db = makeMockDb();
    const r = await runCruiseMapperItineraryActor(db as never);
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(/ingest_disabled/);
    expect(db._inserts).toHaveLength(0);
  });

  it("skips when APIFY_ADAPTER_ENABLED is not 'true' even if itinerary flag is on", async () => {
    process.env.CRUISEMAPPER_ITINERARY_INGEST_ENABLED = "true";
    const db = makeMockDb();
    const r = await runCruiseMapperItineraryActor(db as never);
    expect(r.reason).toMatch(/adapter_disabled/);
  });

  it("skips when APIFY_API_TOKEN is missing", async () => {
    process.env.CRUISEMAPPER_ITINERARY_INGEST_ENABLED = "true";
    process.env.APIFY_ADAPTER_ENABLED = "true";
    const db = makeMockDb();
    const r = await runCruiseMapperItineraryActor(db as never);
    expect(r.reason).toMatch(/no_api_token/);
  });

  it("skips + fires operator alert when monthly cap exhausted", async () => {
    process.env.CRUISEMAPPER_ITINERARY_INGEST_ENABLED = "true";
    process.env.APIFY_ADAPTER_ENABLED = "true";
    process.env.APIFY_API_TOKEN = "test-token";
    process.env.APIFY_MONTHLY_BUDGET_USD_CEILING = "100";
    const db = makeMockDb({ monthlySpend: 150 });
    const r = await runCruiseMapperItineraryActor(db as never);
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(/monthly_budget_exhausted/);
    expect(alertCalls).toHaveLength(1);
  });
});
