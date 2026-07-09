// D-091 R3 #51 follow-up (hardened #1577) — bookings-stuck-submitting-reconcile probe.
//
// The cron sweeps bookings stuck in 'submitting' status for >5 minutes and
// routes them to 'pending_host_review' (reason 'host_state_unknown') via a
// status-CAS update — NEVER back to 'draft', which would risk a duplicate live
// host booking (#1577). Tests:
//
//   - Pattern 1: fetch error throws.
//   - Pattern 6: CAS race — a row that was 'submitting' at fetch time but
//     transitioned to 'submitted' (real completion) between fetch and
//     update lands as a 0-row CAS mismatch and is NOT flagged.
//   - #1577: the CAS update targets pending_host_review + host_state_unknown,
//     not draft.
//   - Happy path: stuck rows flagged, count returned.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** Rows returned by the initial fetch. */
  stuckRows: [] as Array<{ id: string; tenant_id: string; updated_at: string }>,
  /** Whether the initial fetch errors. */
  fetchError: null as { message: string } | null,
  /** Per-row CAS update result: number of rows the update affected. */
  casRowsPerRow: 1 as 0 | 1,
  /** Payloads captured from every bookings.update() call. */
  updatePayloads: [] as Array<Record<string, unknown>>,
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
        update(payload: Record<string, unknown>) {
          mocks.updatePayloads.push(payload);
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
  mocks.updatePayloads = [];
});

const ORIG_BOOKING_CRONS = process.env.BOOKING_CRONS_DISABLED;
const ORIG_RECONCILE = process.env.BOOKING_RECONCILE_DISABLED;

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIG_BOOKING_CRONS === undefined) delete process.env.BOOKING_CRONS_DISABLED;
  else process.env.BOOKING_CRONS_DISABLED = ORIG_BOOKING_CRONS;
  if (ORIG_RECONCILE === undefined) delete process.env.BOOKING_RECONCILE_DISABLED;
  else process.env.BOOKING_RECONCILE_DISABLED = ORIG_RECONCILE;
});

// #1694 — this safety net now gates on BOOKING_RECONCILE_DISABLED, not
// BOOKING_CRONS_DISABLED. Both-directions: the dedicated switch stops it; the
// money-movement switch does NOT (a stuck 'submitting' row most needs flagging
// exactly when new money movement is paused).
describe("runBookingsStuckSubmittingReconcile — BOOKING_RECONCILE_DISABLED kill switch (#1694)", () => {
  it("returns zero counts without touching the DB when BOOKING_RECONCILE_DISABLED is true", async () => {
    process.env.BOOKING_RECONCILE_DISABLED = "true";
    mocks.stuckRows = [
      { id: "booking-1", tenant_id: "t-1", updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
    ];
    const result = await runBookingsStuckSubmittingReconcile();
    expect(result).toEqual({ flagged: 0, total_stuck: 0 });
    // DB was never consulted — no CAS update captured.
    expect(mocks.updatePayloads).toHaveLength(0);
  });

  it("STILL runs and flags stuck rows when only BOOKING_CRONS_DISABLED is true (safety net survives the money-movement pause)", async () => {
    process.env.BOOKING_CRONS_DISABLED = "true";
    delete process.env.BOOKING_RECONCILE_DISABLED;
    mocks.stuckRows = [
      { id: "booking-1", tenant_id: "t-1", updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
    ];
    mocks.casRowsPerRow = 1;
    const result = await runBookingsStuckSubmittingReconcile();
    expect(result).toEqual({ flagged: 1, total_stuck: 1 });
    expect(mocks.updatePayloads[0]).toMatchObject({
      status: "pending_host_review",
      review_reason: "host_state_unknown",
    });
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
    expect(result).toEqual({ flagged: 0, total_stuck: 0 });
  });

  it("counts flagged when CAS update affects the row", async () => {
    mocks.stuckRows = [
      { id: "booking-1", tenant_id: "t-1", updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
    ];
    mocks.casRowsPerRow = 1;
    const result = await runBookingsStuckSubmittingReconcile();
    expect(result).toEqual({ flagged: 1, total_stuck: 1 });
  });

  it("#1577 — routes the stuck row to pending_host_review/host_state_unknown, NEVER draft", async () => {
    // The money-safety invariant: a stuck 'submitting' row may hide a real
    // live host booking, so it must never be reverted to a re-submittable
    // 'draft'. This assertion fails the moment someone regresses the CAS
    // target back to draft.
    mocks.stuckRows = [
      { id: "booking-1", tenant_id: "t-1", updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
    ];
    await runBookingsStuckSubmittingReconcile();
    expect(mocks.updatePayloads).toHaveLength(1);
    expect(mocks.updatePayloads[0]).toMatchObject({
      status: "pending_host_review",
      review_reason: "host_state_unknown",
    });
    expect(mocks.updatePayloads[0]?.status).not.toBe("draft");
  });
});

describe("runBookingsStuckSubmittingReconcile — Pattern 6 (CAS race)", () => {
  it("does NOT count a row as flagged when the CAS update affects 0 rows", async () => {
    // Scenario: row was 'submitting' at fetch time but legitimately
    // transitioned to 'submitted' between fetch and the cron's update.
    // The .eq("status", "submitting") guard makes the update affect 0
    // rows, which the cron correctly treats as "not flagged."
    mocks.stuckRows = [
      { id: "booking-1", tenant_id: "t-1", updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
    ];
    mocks.casRowsPerRow = 0;
    const result = await runBookingsStuckSubmittingReconcile();
    expect(result.flagged).toBe(0);
    expect(result.total_stuck).toBe(1);
  });
});
