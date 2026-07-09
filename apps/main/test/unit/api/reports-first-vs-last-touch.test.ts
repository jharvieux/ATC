// #1745 — GET /api/reports/first-vs-last-touch used to fetch every matching
// booking in a single .select(), which PostgREST's ~1000-row db-max-rows cap
// silently truncates regardless of any requested .limit() — the pair counts
// would be wrong with no error surfaced. This proves the route now pages
// with .range() and the counts cover every row, including ones past the old
// 1000-row cap.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  bookingPages: [] as Array<Array<Record<string, unknown>>>,
  order: vi.fn(),
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
          order: (...args: unknown[]) => {
            mocks.order(...args);
            return chain;
          },
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

import { GET } from "@/app/api/reports/first-vs-last-touch/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({ ctx: { tenant_id: "t-1" } });
  mocks.bookingPages = [];
});

function req(): Request {
  return new Request("http://test/api/reports/first-vs-last-touch?start=2026-01-01&end=2026-12-31");
}

describe("GET /api/reports/first-vs-last-touch — pair counts survive >1000 rows (#1745)", () => {
  it("counts all 1300 social->search pairs, not just the first 1000 PostgREST would return", async () => {
    const PAGE = 1000;
    const makeRow = (i: number) => ({
      id: `b-${i}`,
      conversion_touch_channel: "search",
      contacts: { first_touch_channel: "social" },
    });
    const page1 = Array.from({ length: PAGE }, (_, i) => makeRow(i));
    const page2 = Array.from({ length: 300 }, (_, i) => makeRow(PAGE + i));
    mocks.bookingPages = [page1, page2];

    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ first: string; last: string; count: number }> };

    const pair = body.items.find((i) => i.first === "social" && i.last === "search");
    expect(pair?.count).toBe(1300);
    // #1765 — every page must request a stable sort, or LIMIT/OFFSET paging
    // over concurrently-inserted rows can skip or double-count across pages.
    expect(mocks.order).toHaveBeenCalledWith("id", { ascending: true });
  });
});
