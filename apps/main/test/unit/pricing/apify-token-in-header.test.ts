// D-091 P1 #2 — verify Apify token is sent in Authorization header,
// not in URL query string. Catches any future regression that moves
// the token back to ?token=... (which would leak via proxy/APM logs).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface CapturedFetch {
  url: string;
  init: RequestInit;
}

const captured: CapturedFetch[] = [];
const originalFetch = global.fetch;

beforeEach(() => {
  captured.length = 0;
  // @ts-expect-error — stub fetch globally for the dispatcher
  global.fetch = vi.fn(async (url: string, init: RequestInit) => {
    captured.push({ url, init });
    return new Response("[]", {
      status: 200,
      headers: { "x-apify-actor-run-id": "test-run-id" },
    });
  });
  process.env.APIFY_ADAPTER_ENABLED = "true";
  process.env.APIFY_API_TOKEN = "apify_api_secrettoken123";
  process.env.APIFY_ENABLED_RCL = "true";
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.APIFY_ADAPTER_ENABLED;
  delete process.env.APIFY_API_TOKEN;
  delete process.env.APIFY_ENABLED_RCL;
});

// Minimal mock-db that satisfies the spend ledger reads + writes.
function makeMockDb(): unknown {
  return {
    from() {
      return {
        async insert() { return { data: null, error: null }; },
        async update() { return { data: null, error: null }; },
        async upsert() { return { data: null, error: null }; },
        select() {
          const chain = {
            eq() { return chain; },
            gte() { return chain; },
            maybeSingle() {
              return Promise.resolve({ data: null, error: null });
            },
            then(resolve: (v: { data: unknown[] }) => unknown) {
              return resolve({ data: [] });
            },
          };
          return chain;
        },
      };
    },
  };
}

describe("ApifyPricingAdapter — token placement (D-091 P1 #2)", () => {
  it("sends token in Authorization Bearer header, never in URL", async () => {
    const { ApifyPricingAdapter } = await import("../../../src/lib/pricing/apify-pricing-adapter");
    const adapter = new ApifyPricingAdapter(makeMockDb() as never);
    await adapter.refreshTrackedSailings([
      {
        line: "RCL",
        ship: "symphony-of-the-seas",
        sailDate: "2026-08-15",
        departurePort: "MIA",
        durationNights: 7,
      },
    ]);
    expect(captured).toHaveLength(1);
    const { url, init } = captured[0]!;

    // 1. URL must NOT contain the token, ?token=, or any query string at all.
    expect(url).not.toContain("token=");
    expect(url).not.toContain("apify_api_secrettoken123");
    expect(url).not.toContain("?");

    // 2. Token must be in Authorization header as Bearer token.
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer apify_api_secrettoken123");
  });
});
