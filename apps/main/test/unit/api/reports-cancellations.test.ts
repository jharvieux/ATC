// #1745 — GET /api/reports/cancellations used to fetch every matching
// cancelled booking in a single .select(), which PostgREST's ~1000-row
// db-max-rows cap silently truncates regardless of any requested .limit() —
// the lost-revenue totals would be wrong with no error surfaced. This proves
// the route now pages with .range() and the totals cover every row,
// including ones past the old 1000-row cap.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
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

import { GET } from "@/app/api/reports/cancellations/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({ ctx: { tenant_id: "t-1" } });
  mocks.bookingPages = [];
});

function req(): Request {
  return new Request("http://test/api/reports/cancellations?start=2026-01-01&end=2026-12-31&group_by=channel");
}

describe("GET /api/reports/cancellations — rollup survives >1000 rows (#1745)", () => {
  it("sums lost-revenue/clawback across all 1500 cancellations, not just the first 1000 PostgREST would return", async () => {
    const PAGE = 1000;
    const makeRow = (i: number) => ({
      id: `c-${i}`,
      cancellation_reason_category: "customer_changed_mind",
      conversion_touch_channel: "email",
      cruise_line: "Royal",
      sailing_date: "2026-08-01",
      commissions: { gross_commission_cents: 200, received_commission_cents: 0, clawback_amount_cents: 50 },
    });
    const page1 = Array.from({ length: PAGE }, (_, i) => makeRow(i));
    const page2 = Array.from({ length: 500 }, (_, i) => makeRow(PAGE + i));
    mocks.bookingPages = [page1, page2];

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ category: string; cancelled_count: number; lost_expected_cents: number; clawback_cents: number }>;
    };

    const bucket = body.items.find((i) => i.category === "customer_changed_mind");
    expect(bucket?.cancelled_count).toBe(1500);
    expect(bucket?.lost_expected_cents).toBe(1500 * 200);
    expect(bucket?.clawback_cents).toBe(1500 * 50);
  });
});
