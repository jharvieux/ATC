// §14.9 / D-091 #846 — Booking cancellation CAS guard.
//
// Pins two runtime paths introduced in #846:
//   1. ROW_COUNT_MISMATCH (payout raced out of "pending") → 409 so caller retries.
//   2. Any other DB error on the CAS update → re-throw → respondToAuthError → 500.
//
// These paths have distinct business consequences: 409 is a recoverable
// concurrency signal; 500 is an infrastructure failure. Collapsing them
// (the pre-fix `.catch(() => null)` pattern) masked DB errors as silent
// no-ops and hid the clawback gap.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SupabaseMutationError } from "@/lib/db/safe-mutation";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  bookingSingle: vi.fn(),
  commissionMaybeSingle: vi.fn(),
  payoutMaybeSingle: vi.fn(),
  safeAwait: vi.fn().mockResolvedValue(null),
  safeAwaitRowCount: vi.fn(),
  transitionCommissionState: vi.fn().mockResolvedValue(undefined),
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/db/safe-mutation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/safe-mutation")>(
    "@/lib/db/safe-mutation",
  );
  return { ...actual, safeAwait: mocks.safeAwait, safeAwaitRowCount: mocks.safeAwaitRowCount };
});

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      if (table === "commissions") {
        const chain: Record<string, unknown> = {};
        chain.eq = () => chain;
        chain.maybeSingle = mocks.commissionMaybeSingle;
        return { select: () => chain };
      }
      // bookings: select (lookup) + update (mark cancelled, passed to safeAwait)
      return {
        select: () => ({ eq: () => ({ single: mocks.bookingSingle }) }),
        update: () => ({ eq: () => ({}) }),
      };
    },
  }),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "payout_records") {
        // Supports both the lookup chain (.select().eq()...maybeSingle()) and
        // the CAS update chain (.update().eq()...select("id")), both via the
        // same fluent mock — safeAwaitRowCount is mocked so the CAS chain's
        // result is never awaited directly.
        const chain: Record<string, unknown> = {};
        const self = () => new Proxy(chain, {
          get(_t, prop) {
            if (prop === "maybeSingle") return mocks.payoutMaybeSingle;
            return self;
          },
        });
        return self();
      }
      // platform_revenue.insert + commissions.update — passed to safeAwait (mocked)
      return {
        insert: () => ({}),
        update: () => ({ eq: () => ({ eq: () => ({}) }) }),
      };
    },
  }),
}));

vi.mock("@/lib/commissions/state-machine", () => ({
  transitionCommissionState: mocks.transitionCommissionState,
}));

vi.mock("@/lib/audit/write", () => ({
  writeAuditLog: mocks.writeAuditLog,
}));

import { POST } from "@/app/api/bookings/[id]/cancel/route";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const BOOKING_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const COMMISSION_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const PAYOUT_ID = "pppppppp-pppp-pppp-pppp-pppppppppppp";

function makeReq(body: unknown = {}): Request {
  return new Request(`https://example.com/api/bookings/${BOOKING_ID}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});

  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID },
  });
  mocks.bookingSingle.mockResolvedValue({
    data: { id: BOOKING_ID, status: "active" },
    error: null,
  });
  mocks.commissionMaybeSingle.mockResolvedValue({
    data: {
      id: COMMISSION_ID,
      status: "received",
      platform_retained_cents: BigInt(5000),
      currency: "USD",
      platform_split_rate: 0.1,
      received_commission_cents: BigInt(50000),
      gross_commission_cents: BigInt(50000),
    },
    error: null,
  });
  mocks.payoutMaybeSingle.mockResolvedValue({
    data: {
      id: PAYOUT_ID,
      status: "pending",
      stripe_transfer_id: null,
      settled_at: null,
      amount_cents: BigInt(45000),
    },
    error: null,
  });
  mocks.safeAwait.mockResolvedValue(null);
  mocks.transitionCommissionState.mockResolvedValue(undefined);
  mocks.writeAuditLog.mockResolvedValue(undefined);
});

describe("POST /api/bookings/[id]/cancel — CAS guard (#846)", () => {
  it("returns 409 when payout raced out of pending (ROW_COUNT_MISMATCH = CAS-miss)", async () => {
    // The payout transitioned out of "pending" between the lookup and the
    // update; safeAwaitRowCount sees 0 matched rows and throws ROW_COUNT_MISMATCH.
    mocks.safeAwaitRowCount.mockRejectedValue(
      new SupabaseMutationError("payout_records.cas_cancel", {
        message: "Expected 1 row(s); got 0. CAS guard or constraint mismatch.",
        code: "ROW_COUNT_MISMATCH",
        hint: "",
        details: null,
        name: "RowCountMismatch",
      } as never),
    );

    const res = await POST(makeReq(), { params: Promise.resolve({ id: BOOKING_ID }) });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("payout_state_changed");
    // Early return — no side effects after a CAS miss
    expect(mocks.transitionCommissionState).not.toHaveBeenCalled();
  });

  it("re-throws (→ 500) when the CAS update fails for a non-concurrency DB reason", async () => {
    // A non-ROW_COUNT_MISMATCH SupabaseMutationError (e.g. connection reset,
    // permission error) must surface as 500, not silently convert to 409.
    // Pre-fix `.catch(() => null)` would have treated this as a CAS-miss,
    // hiding the infrastructure failure and leaving the payout un-cancelled.
    mocks.safeAwaitRowCount.mockRejectedValue(
      new SupabaseMutationError("payout_records.cas_cancel", {
        message: "connection reset by server",
        code: "CONNECTION_ERROR",
        hint: "",
        details: null,
        name: "DBError",
      } as never),
    );

    const res = await POST(makeReq(), { params: Promise.resolve({ id: BOOKING_ID }) });

    expect(res.status).toBe(500);
    expect(mocks.transitionCommissionState).not.toHaveBeenCalled();
  });
});
