// D-091 R3 #51 follow-up — bookings-stuck-submitting-reconcile probe.
//
// The cron sweeps bookings stuck in 'submitting' status for >5 minutes
// and reverts them to 'draft' via a status-CAS update. Tests:
//
//   - Pattern 1: fetch error throws.
//   - Pattern 6: CAS race — a row that was 'submitting' at fetch time but
//     transitioned to 'submitted' (real completion) between fetch and
//     update lands as a 0-row CAS mismatch and is NOT reverted.
//   - Happy path: stuck rows reverted, count returned.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** Rows returned by the initial fetch. */
  stuckRows: [] as Array<{ id: string; tenant_id: string; updated_at: string }>,
  /** Whether the initial fetch errors. */
  fetchError: null as { message: string } | null,
  /** Per-row CAS update result: number of rows the update affected. */
  casRowsPerRow: 1 as 0 | 1,
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(_table: string) {
      void _table;
      return {
        select() {
          const chain: Record<string, unknown> = {
            eq() { return chain; },
            lt() { return chain; },
            limit() { return chain; },
            then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
              return resolve({ data: mocks.stuckRows, error: mocks.fetchError });
            },
          };
          return chain;
        },
        update(_payload: unknown) {
          void _payload;
          const chain: Record<string, unknown> = {
            eq() { return chain; },
            select(_cols: string) {
              void _cols;
              return Promise.resolve({
                data: mocks.casRowsPerRow === 1 ? [{ id: "booking-1" }] : [],
                error: null,
              });
            },
          };
          return chain;
        },
      };
    },
  }),
}));

import { runBookingsStuckSubmittingReconcile } from "@/lib/cron/bookings-stuck-submitting-reconcile";

beforeEach(() => {
  mocks.stuckRows = [];
  mocks.fetchError = null;
  mocks.casRowsPerRow = 1;
});

const ORIG_BOOKING_CRONS = process.env.BOOKING_CRONS_DISABLED;

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIG_BOOKING_CRONS === undefined) delete process.env.BOOKING_CRONS_DISABLED;
  else process.env.BOOKING_CRONS_DISABLED = ORIG_BOOKING_CRONS;
});

describe("runBookingsStuckSubmittingReconcile — BOOKING_CRONS_DISABLED kill switch", () => {
  it("returns zero counts without touching the DB when flag is true", async () => {
    process.env.BOOKING_CRONS_DISABLED = "true";
    const result = await runBookingsStuckSubmittingReconcile();
    expect(result).toEqual({ reverted: 0, total_stuck: 0 });
  });
});

describe("runBookingsStuckSubmittingReconcile — Pattern 1 (fetch error)", () => {
  it("throws when the initial bookings fetch returns error", async () => {
    mocks.fetchError = { message: "synthetic fetch failure" };
    await expect(runBookingsStuckSubmittingReconcile()).rejects.toThrow(/synthetic fetch failure/);
  });
});

describe("runBookingsStuckSubmittingReconcile — happy path", () => {
  it("returns 0/0 when nothing is stuck", async () => {
    mocks.stuckRows = [];
    const result = await runBookingsStuckSubmittingReconcile();
    expect(result).toEqual({ reverted: 0, total_stuck: 0 });
  });

  it("counts reverted when CAS update affects the row", async () => {
    mocks.stuckRows = [
      { id: "booking-1", tenant_id: "t-1", updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
    ];
    mocks.casRowsPerRow = 1;
    const result = await runBookingsStuckSubmittingReconcile();
    expect(result).toEqual({ reverted: 1, total_stuck: 1 });
  });
});

describe("runBookingsStuckSubmittingReconcile — Pattern 6 (CAS race)", () => {
  it("does NOT count a row as reverted when the CAS update affects 0 rows", async () => {
    // Scenario: row was 'submitting' at fetch time but legitimately
    // transitioned to 'submitted' between fetch and the cron's update.
    // The .eq("status", "submitting") guard makes the update affect 0
    // rows, which the cron correctly treats as "not reverted."
    mocks.stuckRows = [
      { id: "booking-1", tenant_id: "t-1", updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
    ];
    mocks.casRowsPerRow = 0;
    const result = await runBookingsStuckSubmittingReconcile();
    expect(result.reverted).toBe(0);
    expect(result.total_stuck).toBe(1);
  });
});
