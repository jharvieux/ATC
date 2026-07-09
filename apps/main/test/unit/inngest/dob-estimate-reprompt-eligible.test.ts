// #1745 — getUsersWithImminentBookings (dob-estimate-reprompt-eligible.ts)
// used to fetch every matching bookings row in a single .select(), which
// PostgREST's ~1000-row db-max-rows cap silently truncates regardless of any
// requested .limit(). A user whose imminent booking fell past that cap would
// wrongly stay eligible for a DOB re-prompt the §20.5 submit gate already
// covers. This proves the query now pages with .range() so a user on the
// SECOND page is still recognized as having an imminent booking and skipped.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  updateCalls: [] as string[],
  // bookings rows served per .range() page, in insertion order.
  bookingPages: [] as Array<Array<{ user_id: string | null }>>,
  order: vi.fn(),
}));

vi.mock("@/inngest/client", () => ({
  inngest: { createFunction: (_cfg: unknown, handler: unknown) => handler },
}));

vi.mock("@/lib/memory/dob", () => ({
  isEstimatedDOBOverdue: () => true,
  imminentBookingWindowMs: () => 60 * 24 * 60 * 60 * 1000, // 60 days
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => {
    let bookingPageIndex = 0;
    return {
      from(table: string) {
        if (table === "customer_memories") {
          return {
            select: () => ({
              eq: () => ({
                not: async () => ({
                  data: [
                    {
                      id: "cm-1",
                      user_id: "user-past-cap",
                      tenant_id: "t-1",
                      family_composition: [{ date_of_birth_is_estimated: true }],
                      awaiting_dob_reprompt: false,
                    },
                  ],
                  error: null,
                }),
              }),
            }),
            update: () => ({
              eq: () => ({
                eq: async () => {
                  mocks.updateCalls.push("cm-1");
                  return { error: null };
                },
              }),
            }),
          };
        }
        if (table === "messages") {
          return {
            select: () => ({
              eq: () => ({
                gte: () => ({
                  not: async () => ({ data: [{ user_id: "user-past-cap" }], error: null }),
                }),
              }),
            }),
          };
        }
        // bookings — paginated imminent-booking scan.
        const chain = {
          gte: () => chain,
          lte: () => chain,
          not: () => chain,
          order: (...args: unknown[]) => {
            mocks.order(...args);
            return chain;
          },
          range: () => {
            const page = mocks.bookingPages[bookingPageIndex] ?? [];
            bookingPageIndex += 1;
            return Promise.resolve({ data: page, error: null });
          },
        };
        return { select: () => chain };
      },
    };
  },
}));

import { dobEstimateRepromptEligible } from "@/inngest/dob-estimate-reprompt-eligible";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateCalls = [];
  mocks.bookingPages = [];
});

describe("dob-estimate-reprompt-eligible — imminent-bookings scan survives >1000 rows (#1745)", () => {
  it("recognizes an imminent booking on the SECOND .range() page and skips that user's reprompt flag", async () => {
    const PAGE = 1000;
    // Page 1: 1000 unrelated bookings. Page 2: the booking for the user under
    // test — old code returning only page 1 would miss it and wrongly flag
    // the user for reprompt despite an imminent booking.
    const page1 = Array.from({ length: PAGE }, (_, i) => ({ user_id: `filler-${i}` }));
    const page2 = [{ user_id: "user-past-cap" }];
    mocks.bookingPages = [page1, page2];

    const result = await (dobEstimateRepromptEligible as unknown as () => Promise<{
      status: string;
      flagged: number;
      skipped_imminent: number;
    }>)();

    expect(result.skipped_imminent).toBe(1);
    expect(result.flagged).toBe(0);
    expect(mocks.updateCalls).toHaveLength(0);
    // #1765 — every page must request a stable sort, or LIMIT/OFFSET paging
    // over concurrently-inserted rows can skip or double-count across pages.
    expect(mocks.order).toHaveBeenCalledWith("id", { ascending: true });
  });
});
