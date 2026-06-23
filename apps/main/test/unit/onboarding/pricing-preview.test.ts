// §15.8 — GET /api/pricing/preview
//
// The route now sources prices from the DB (tier_definitions + pricing_seat_ladder,
// EPIC #1336) via loadPricingTable, read through the service-role client. These
// tests mock that client with DB rows derived from PRICING_FALLBACK (the §3.3
// seed), so they exercise the real DB-read path and still assert the §3.3 values:
//   sub_host:  starter $49/mo, pro $149/mo, agency $249/mo base
//   byo_host:  starter $19/mo, pro  $59/mo, agency  $99/mo base

import { describe, it, expect, vi } from "vitest";

// Mock the service-role client so loadPricingTable reads seeded §3.3 rows
// instead of hitting a real DB (and so createServiceRoleClient doesn't throw on
// the missing env in unit tests). Rows are built from PRICING_FALLBACK to keep a
// single source for the numbers; the final ladder band uses the INT4 sentinel
// exactly as the migration seeds it.
vi.mock("@/lib/db/service-role-client", async () => {
  const { PRICING_FALLBACK } =
    await vi.importActual<typeof import("@/lib/abuse/revenue")>("@/lib/abuse/revenue");
  const tierRows = Object.entries(PRICING_FALLBACK.base).map(([code, p]) => ({
    code,
    base_price_monthly_cents: p.monthly,
    base_price_annual_cents: p.annual,
  }));
  const ladderRows = PRICING_FALLBACK.seatLadder.map((b, i) => ({
    up_to_seat: b.upTo === Infinity ? 2147483647 : b.upTo,
    monthly_cents: b.monthly,
    annual_cents: b.annual,
    sort_order: i + 1,
  }));
  const byTable: Record<string, { data: unknown; error: null }> = {
    tier_definitions: { data: tierRows, error: null },
    pricing_seat_ladder: { data: ladderRows, error: null },
  };
  const makeChain = (t: string) => {
    const result = byTable[t] ?? { data: [], error: null };
    const chain = {
      select: () => chain,
      order: () => chain,
      eq: () => chain,
      then: (resolve: (r: unknown) => unknown) => resolve(result),
    };
    return chain;
  };
  return { createServiceRoleClient: () => ({ from: (t: string) => makeChain(t) }) };
});

function get(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return new Request(`http://test/api/pricing/preview?${qs}`);
}

describe("GET /api/pricing/preview — base prices match §3.3", () => {
  it("sub_host starter monthly → 4900 cents ($49)", async () => {
    const { GET } = await import("@/app/api/pricing/preview/route");
    const res = await GET(get({ tier: "starter", billing_period: "monthly", tenant_type: "sub_host" }));
    const body = await res.json() as { total_cents: number };
    expect(body.total_cents).toBe(4900);
  });

  it("sub_host pro monthly → 14900 cents ($149)", async () => {
    const { GET } = await import("@/app/api/pricing/preview/route");
    const res = await GET(get({ tier: "pro", billing_period: "monthly", tenant_type: "sub_host" }));
    const body = await res.json() as { total_cents: number };
    expect(body.total_cents).toBe(14900);
  });

  it("sub_host agency 1 seat monthly → 24900 cents ($249 base, 0 additional)", async () => {
    const { GET } = await import("@/app/api/pricing/preview/route");
    const res = await GET(get({ tier: "agency", billing_period: "monthly", seats: "1", tenant_type: "sub_host" }));
    const body = await res.json() as { base_cents: number; additional_seat_cents: number; total_cents: number };
    expect(body.base_cents).toBe(24900);
    expect(body.additional_seat_cents).toBe(0);
    expect(body.total_cents).toBe(24900);
  });

  it("byo_host starter monthly → 1900 cents ($19)", async () => {
    const { GET } = await import("@/app/api/pricing/preview/route");
    const res = await GET(get({ tier: "starter", billing_period: "monthly", tenant_type: "byo_host" }));
    const body = await res.json() as { total_cents: number };
    expect(body.total_cents).toBe(1900);
  });

  it("byo_host pro monthly → 5900 cents ($59)", async () => {
    const { GET } = await import("@/app/api/pricing/preview/route");
    const res = await GET(get({ tier: "pro", billing_period: "monthly", tenant_type: "byo_host" }));
    const body = await res.json() as { total_cents: number };
    expect(body.total_cents).toBe(5900);
  });

  it("byo_host agency 1 seat monthly → 9900 cents ($99 base, 0 additional)", async () => {
    const { GET } = await import("@/app/api/pricing/preview/route");
    const res = await GET(get({ tier: "agency", billing_period: "monthly", seats: "1", tenant_type: "byo_host" }));
    const body = await res.json() as { base_cents: number; total_cents: number };
    expect(body.base_cents).toBe(9900);
    expect(body.total_cents).toBe(9900);
  });
});

describe("GET /api/pricing/preview — agency with additional seats", () => {
  it("sub_host agency 4 seats monthly → 24900 + 3×$59 = $426 (42600 cents)", async () => {
    const { GET } = await import("@/app/api/pricing/preview/route");
    const res = await GET(get({ tier: "agency", billing_period: "monthly", seats: "4", tenant_type: "sub_host" }));
    const body = await res.json() as { base_cents: number; additional_seat_cents: number; total_cents: number };
    expect(body.base_cents).toBe(24900);
    expect(body.additional_seat_cents).toBe(3 * 5900); // 17700 — 3 seats in band1
    expect(body.total_cents).toBe(24900 + 3 * 5900); // 42600
  });
});

describe("GET /api/pricing/preview — annual billing", () => {
  it("sub_host starter annual → 49000 cents ($490, monthly × 10)", async () => {
    const { GET } = await import("@/app/api/pricing/preview/route");
    const res = await GET(get({ tier: "starter", billing_period: "annual", tenant_type: "sub_host" }));
    const body = await res.json() as { total_cents: number };
    expect(body.total_cents).toBe(49000);
  });
});

describe("GET /api/pricing/preview — validation", () => {
  it("returns 400 when tier is missing", async () => {
    const { GET } = await import("@/app/api/pricing/preview/route");
    const res = await GET(get({ billing_period: "monthly" }));
    expect(res.status).toBe(400);
  });

  it("returns 422 for invalid tenant_type", async () => {
    const { GET } = await import("@/app/api/pricing/preview/route");
    const res = await GET(get({ tier: "starter", billing_period: "monthly", tenant_type: "unknown_type" }));
    expect(res.status).toBe(422);
  });
});
