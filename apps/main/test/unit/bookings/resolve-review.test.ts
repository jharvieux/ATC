// §14.4 / #1764 — pending_host_review → draft resolution transition.
//
// WHY these tests matter: the transition is money-critical. Reverting a booking
// that already reached the host adapter would double-book at the cruise line
// (#1577). The suite pins that ONLY pre-host review reasons are revertible and
// that post-host reasons (commission_write_failed / host_state_unknown) are
// refused — a regression that widened the safe set would silently reintroduce
// the double-book. It also pins that a successful revert is audit-logged.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolvePendingHostReview,
  SAFE_TO_RESUBMIT_REVIEW_REASONS,
} from "@/lib/bookings/state-machine";

const writeAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit/write", () => ({ writeAuditLog: (...a: unknown[]) => writeAuditLog(...a) }));

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const BOOKING_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

// Minimal Supabase query-builder mock. `casRows` is what the CAS update's
// terminal .select("id") resolves to; `currentRow` is what the explanatory
// read (.maybeSingle()) resolves to. The CAS predicate (status + safe reason)
// is applied here so the mock faithfully models the DB gate.
function makeDb(currentRow: { status: string; review_reason: string | null } | null) {
  const casMatches =
    currentRow?.status === "pending_host_review" &&
    currentRow.review_reason != null &&
    (SAFE_TO_RESUBMIT_REVIEW_REASONS as readonly string[]).includes(currentRow.review_reason);

  const from = vi.fn(() => ({
    update: vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => ({
          in: vi.fn(() => ({
            select: vi.fn(() =>
              Promise.resolve({ data: casMatches ? [{ id: BOOKING_ID }] : [], error: null }),
            ),
          })),
        })),
      })),
    })),
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(() => Promise.resolve({ data: currentRow, error: null })),
      })),
    })),
  }));
  return { from } as never;
}

function call(currentRow: { status: string; review_reason: string | null } | null) {
  return resolvePendingHostReview({
    db: makeDb(currentRow),
    bookingId: BOOKING_ID,
    actorUserId: USER_ID,
    tenantId: TENANT_ID,
  });
}

beforeEach(() => {
  writeAuditLog.mockClear();
});

describe("resolvePendingHostReview (§14.4 / #1764)", () => {
  it.each(SAFE_TO_RESUBMIT_REVIEW_REASONS)(
    "reverts pending_host_review→draft for pre-host reason %s and audit-logs it",
    async (reason) => {
      const result = await call({ status: "pending_host_review", review_reason: reason });
      expect(result).toEqual({ ok: true });
      expect(writeAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking.review_resolved",
          resource_id: BOOKING_ID,
          changes: { from: "pending_host_review", to: "draft" },
        }),
      );
    },
  );

  it.each(["commission_write_failed", "host_state_unknown"])(
    "REFUSES revert for post-host reason %s (double-book guard, #1577)",
    async (reason) => {
      const result = await call({ status: "pending_host_review", review_reason: reason });
      expect(result).toEqual({
        ok: false,
        code: "host_booking_may_exist",
        status: "pending_host_review",
        review_reason: reason,
      });
      expect(writeAuditLog).not.toHaveBeenCalled();
    },
  );

  it("refuses a pending_host_review row with a null reason (fail-closed)", async () => {
    const result = await call({ status: "pending_host_review", review_reason: null });
    expect(result).toMatchObject({ ok: false, code: "host_booking_may_exist" });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("returns not_in_review when the booking is no longer in review", async () => {
    const result = await call({ status: "submitted", review_reason: null });
    expect(result).toMatchObject({ ok: false, code: "not_in_review", status: "submitted" });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("returns not_found when the booking does not exist", async () => {
    const result = await call(null);
    expect(result).toMatchObject({ ok: false, code: "not_found" });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});
