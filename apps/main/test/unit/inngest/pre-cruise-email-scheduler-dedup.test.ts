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

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  contentRow: null as { id: string; sent_at: string | null } | null,
  sentEvents: [] as Array<{ name: string; data: unknown }>,
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
                    groups: { sailing_date: new Date(Date.now() + 168 * 60 * 60 * 1000).toISOString() },
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

import { preCruiseEmailSchedulerMultiphase } from "@/inngest/pre-cruise-email-scheduler";

beforeEach(() => {
  mocks.contentRow = null;
  mocks.sentEvents = [];
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
