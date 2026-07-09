// #1745 — GET /api/reports/bookings-by-source used to fetch every matching
// booking in a single .select(), which PostgREST's ~1000-row db-max-rows cap
// silently truncates regardless of any requested .limit() — the revenue/
// commission totals would be wrong with no error surfaced. This proves the
// route now pages with .range() and the per-source totals cover every row,
// including ones past the old 1000-row cap.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  // Rows served by the paginated bookings query, split into pages in
  // insertion order — one page consumed per .range() call.
  bookingPages: [] as Array<Array<Record<string, unknown>>>,
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: mocks.assertPermission,
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => {
    let pageIndex = 0;
    return {
      from(table: string) {
        if (table === "tenants") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { tier_definitions: { code: "pro" } },
                  error: null,
                }),
              }),
            }),
          };
        }
        // bookings
        const chain = {
          eq: () => chain,
          not: () => chain,
          gte: () => chain,
          lte: () => chain,
          range: () => {
            const page = mocks.bookingPages[pageIndex] ?? [];
            pageIndex += 1;
            return Promise.resolve({ data: page, error: null });
          },
        };
        return { select: () => chain };
      },
    };
  },
}));

import { GET } from "@/app/api/reports/bookings-by-source/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({ ctx: { tenant_id: "t-1" } });
  mocks.bookingPages = [];
});

function req(): Request {
  return new Request("http://test/api/reports/bookings-by-source?start=2026-01-01&end=2026-12-31");
}

describe("GET /api/reports/bookings-by-source — rollup survives >1000 rows (#1745)", () => {
  it("sums commissions across all 1200 bookings, not just the first 1000 PostgREST would return", async () => {
    const PAGE = 1000;
    const makeRow = (i: number, channel: string) => ({
      id: `b-${i}`,
      conversion_touch_channel: channel,
      conversion_touch_utm_source: "src",
      conversion_touch_utm_campaign: "camp",
      commissions: { gross_commission_cents: 100, net_commission_cents: 80 },
    });
    // Page 1: 1000 bookings on channel "email". Page 2: 200 more, same
    // channel — old code returning only page 1 would undercount by 200
    // bookings / 20000 commission cents.
    const page1 = Array.from({ length: PAGE }, (_, i) => makeRow(i, "email"));
    const page2 = Array.from({ length: 200 }, (_, i) => makeRow(PAGE + i, "email"));
    mocks.bookingPages = [page1, page2];

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ channel: string; bookings: number; gross_commission_cents: number }> };

    const emailBucket = body.items.find((i) => i.channel === "email");
    expect(emailBucket?.bookings).toBe(1200);
    expect(emailBucket?.gross_commission_cents).toBe(1200 * 100);
  });
});
