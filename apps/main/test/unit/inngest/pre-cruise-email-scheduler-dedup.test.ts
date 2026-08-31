// #1582 — scheduler must dedup on sent_at, not row existence.
//
// The bug: the scheduler skipped a booking/phase the moment a
// pre_cruise_email_content row existed at all. If a prior send failed all
// its retries (sustained Resend outage, misconfigured tenant key), the row
// exists with sent_at null forever, and the scheduler would never
// re-enqueue that booking — the customer permanently loses the email with
// no alert. This pins that a null-sent_at row is treated as "still due"
// and re-fires precruise/email.due, while a sent_at-populated row is
// skipped as before.
//
// #1676 — both schedulers share the exact same `scanAndEmit` dedup branch,
// but only preCruiseEmailSchedulerMultiphase (T-7/T-30/T-90) was covered.
// preCruiseEmailSchedulerT1 (the hourly, time-sensitive "your cruise is
// tomorrow" path) hits the identical sent_at check with different inputs
// (windowHours=1, T1_ONLY phase set) — a refactor touching only that call
// site could silently reintroduce #1582 with nothing to catch it.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  contentRow: null as { id: string; sent_at: string | null } | null,
  sentEvents: [] as Array<{ name: string; data: unknown }>,
  // Hours-before-sailing for the single mocked booking. Multiphase tests
  // use 168h (matches the T-7 default target); T1 tests set 24h (matches
  // the T-1 default target) so the ±windowHours match fires for the
  // scheduler under test.
  sailingHoursFromNow: 168,
  // #1745 — bookings rows returned per .range() page, in insertion order.
  // null (default) falls back to the single legacy fixture booking below;
  // the pagination test overrides this with >1000 rows across two pages.
  bookingPages: null as Array<Array<{
    id: string;
    tenant_id: string;
    group_booking_id: string;
    groups: { sailing_date: string };
  }>> | null,
  order: vi.fn(),
  contentEqCalls: [] as Array<[string, unknown]>,
}));

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, handler: unknown) => handler,
    send: async (payload: { name: string; data: unknown }) => {
      mocks.sentEvents.push(payload);
    },
  },
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => {
    // #1745 — one client instance per scanAndEmit() call, but .from("bookings")
    // is invoked once PER .range() page in the pagination loop below — pageIndex
    // must live at the client level, not be reset on every .from() call.
    let pageIndex = 0;
    return {
      from(table: string) {
        if (table === "bookings") {
          return {
            select() {
              const chain = {
                eq: () => chain,
                not: () => chain,
                order: (...args: unknown[]) => {
                  mocks.order(...args);
                  return chain;
                },
                // #1745 — scanAndEmit now pages with .range() instead of a
                // single unbounded select. When mocks.bookingPages is set,
                // serve it in order (one page per call) so the fixture
                // below can prove the fan-out loop actually issues a
                // second .range() call; otherwise fall back to the single
                // legacy fixture booking on page 0 and an empty page after.
                range: () => {
                  if (mocks.bookingPages) {
                    const page = mocks.bookingPages[pageIndex] ?? [];
                    pageIndex += 1;
                    return Promise.resolve({ data: page, error: null });
                  }
                  const page = pageIndex === 0
                    ? [{
                        id: "booking-1",
                        tenant_id: "t1",
                        group_booking_id: "g1",
                        groups: {
                          sailing_date: new Date(
                            Date.now() + mocks.sailingHoursFromNow * 60 * 60 * 1000,
                          ).toISOString(),
                        },
                      }]
                    : [];
                  pageIndex += 1;
                  return Promise.resolve({ data: page, error: null });
                },
              };
              return chain;
            },
          };
        }
        // pre_cruise_email_content
        return {
          select() {
            const chain = {
              eq: (column: string, value: unknown) => {
                mocks.contentEqCalls.push([column, value]);
                return chain;
              },
              maybeSingle: async () => ({ data: mocks.contentRow, error: null }),
            };
            return chain;
          },
        };
      },
    };
  },
}));

import {
  preCruiseEmailSchedulerMultiphase,
  preCruiseEmailSchedulerT1,
} from "@/inngest/pre-cruise-email-scheduler";

beforeEach(() => {
  mocks.contentRow = null;
  mocks.sentEvents = [];
  mocks.sailingHoursFromNow = 168;
  mocks.bookingPages = null;
  mocks.contentEqCalls = [];
});

describe("pre-cruise-email-scheduler — #1582 sent_at dedup", () => {
  it("re-fires precruise/email.due when a content row exists but sent_at is null (prior send failed)", async () => {
    mocks.contentRow = { id: "content-1", sent_at: null };
    await (preCruiseEmailSchedulerMultiphase as unknown as () => Promise<unknown>)();
    expect(mocks.sentEvents).toHaveLength(1);
    expect(mocks.sentEvents[0]?.name).toBe("precruise/email.due");
  });

  it("skips when the content row has sent_at populated (already delivered)", async () => {
    mocks.contentRow = { id: "content-1", sent_at: "2026-06-01T00:00:00.000Z" };
    await (preCruiseEmailSchedulerMultiphase as unknown as () => Promise<unknown>)();
    expect(mocks.sentEvents).toHaveLength(0);
  });

  it("fires when no content row exists yet (first attempt)", async () => {
    mocks.contentRow = null;
    await (preCruiseEmailSchedulerMultiphase as unknown as () => Promise<unknown>)();
    expect(mocks.sentEvents).toHaveLength(1);
  });

  it("passes the booking owner to the service-role content dedup lookup", async () => {
    await (preCruiseEmailSchedulerMultiphase as unknown as () => Promise<unknown>)();

    expect(mocks.contentEqCalls).toContainEqual(["booking_id", "booking-1"]);
    expect(mocks.contentEqCalls).toContainEqual(["tenant_id", "t1"]);
    expect(mocks.contentEqCalls).toContainEqual(["email_phase", "t_7"]);
  });
});

// #1676 — same dedup branch, exercised through the T-1 hourly scheduler.
describe("preCruiseEmailSchedulerT1 — #1582 sent_at dedup", () => {
  beforeEach(() => {
    mocks.sailingHoursFromNow = 24; // matches the T-1 default target (24h before sailing)
  });

  it("re-fires precruise/email.due when a content row exists but sent_at is null (prior send failed)", async () => {
    mocks.contentRow = { id: "content-1", sent_at: null };
    await (preCruiseEmailSchedulerT1 as unknown as () => Promise<unknown>)();
    expect(mocks.sentEvents).toHaveLength(1);
    expect(mocks.sentEvents[0]?.name).toBe("precruise/email.due");
    expect((mocks.sentEvents[0]?.data as { via: string }).via).toBe("direct");
  });

  it("skips when the content row has sent_at populated (already delivered) — must not double-send the time-sensitive T-1 email", async () => {
    mocks.contentRow = { id: "content-1", sent_at: "2026-06-01T00:00:00.000Z" };
    await (preCruiseEmailSchedulerT1 as unknown as () => Promise<unknown>)();
    expect(mocks.sentEvents).toHaveLength(0);
  });

  it("fires when no content row exists yet (first attempt)", async () => {
    mocks.contentRow = null;
    await (preCruiseEmailSchedulerT1 as unknown as () => Promise<unknown>)();
    expect(mocks.sentEvents).toHaveLength(1);
  });
});

// #1745 — the bookings scan used to be a single unbounded .select(), which
// PostgREST's ~1000-row db-max-rows cap would silently truncate: some
// confirmed group bookings past row 1000 would never be scanned, and those
// customers would never get a pre-cruise email with no error surfaced
// anywhere. This proves the fan-out now pages past that cap.
describe("pre-cruise-email-scheduler — bookings scan survives >1000 rows (#1745)", () => {
  it("fans out precruise/email.due for a booking on the SECOND .range() page, not just the first 1000", async () => {
    const PAGE = 1000;
    const dueSailing = new Date(Date.now() + 168 * 60 * 60 * 1000).toISOString();
    // Page 1: 1000 bookings whose sailing_date is far outside any phase
    // window (so they don't themselves trigger an event — keeps the
    // assertion below unambiguous). Page 2: one booking that IS due.
    const page1 = Array.from({ length: PAGE }, (_, i) => ({
      id: `filler-${i}`,
      tenant_id: "t1",
      group_booking_id: `g-filler-${i}`,
      groups: { sailing_date: new Date(Date.now() + 5000 * 60 * 60 * 1000).toISOString() },
    }));
    const page2 = [
      { id: "booking-past-cap", tenant_id: "t1", group_booking_id: "g-past-cap", groups: { sailing_date: dueSailing } },
    ];
    mocks.bookingPages = [page1, page2];

    await (preCruiseEmailSchedulerMultiphase as unknown as () => Promise<unknown>)();

    expect(mocks.sentEvents).toHaveLength(1);
    expect(mocks.sentEvents[0]?.data).toMatchObject({ booking_id: "booking-past-cap" });
    // #1765 — every page must request a stable sort, or LIMIT/OFFSET paging
    // over concurrently-inserted rows can skip or double-count across pages.
    expect(mocks.order).toHaveBeenCalledWith("id", { ascending: true });
  });
});
