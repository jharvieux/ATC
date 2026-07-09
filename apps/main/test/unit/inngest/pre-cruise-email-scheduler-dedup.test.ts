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
  createServiceRoleClient: () => ({
    from(table: string) {
      if (table === "bookings") {
        return {
          select() {
            const chain = {
              eq: () => chain,
              not: () => Promise.resolve({
                data: [
                  {
                    id: "booking-1",
                    tenant_id: "t1",
                    group_booking_id: "g1",
                    groups: {
                      sailing_date: new Date(
                        Date.now() + mocks.sailingHoursFromNow * 60 * 60 * 1000,
                      ).toISOString(),
                    },
                  },
                ],
                error: null,
              }),
            };
            return chain;
          },
        };
      }
      // pre_cruise_email_content
      return {
        select() {
          const chain = {
            eq: () => chain,
            maybeSingle: async () => ({ data: mocks.contentRow, error: null }),
          };
          return chain;
        },
      };
    },
  }),
}));

import {
  preCruiseEmailSchedulerMultiphase,
  preCruiseEmailSchedulerT1,
} from "@/inngest/pre-cruise-email-scheduler";

beforeEach(() => {
  mocks.contentRow = null;
  mocks.sentEvents = [];
  mocks.sailingHoursFromNow = 168;
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
