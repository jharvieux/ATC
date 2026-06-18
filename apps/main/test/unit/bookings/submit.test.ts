// §14.3 / §14.4 — POST /api/bookings/[id]/submit.
//
// Covers:
//   - auth gate (401)
//   - booking not found (404)
//   - wrong-status rejection — only draft can submit (422)
//   - CAS lock conflict — concurrent submit (409)
//   - DOB estimate gate (409)
//   - tenant lookup fail-closed (500)
//   - commission rate unresolvable → pending_host_review (503)
//   - platform split rate missing → pending_host_review (503)
//   - host adapter failure → revert CAS lock (502)
//   - commission insert failure (500)
//   - sandbox: commissions row skipped (200)
//   - happy path: submitted with commissions (200)

import { describe, it, expect, vi, beforeEach } from "vitest";

// Local replica — avoids hoisting issue when using DOBEstimateUnresolvedError
// inside the vi.mock factory (the actual import can't be accessed before mocks hoist).
class DOBEstimateUnresolvedError extends Error {
  affectedPassengers: string[];
  constructor(names: string[]) {
    super("Estimated DOBs unresolved");
    this.name = "DOBEstimateUnresolvedError";
    this.affectedPassengers = names;
  }
}

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const BOOKING_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TIER_ID = "tttttttt-tttt-tttt-tttt-tttttttttttt";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  withIdempotencyKey: vi.fn().mockImplementation((_req: unknown, _key: unknown, fn: () => unknown) => fn()),
  // tenantClient chains
  bookingRead: vi.fn(),
  bookingCasLock: vi.fn(),
  commissionsInsert: vi.fn(),
  quotesMaybeSingle: vi.fn(),
  tenantFeeOverride: vi.fn(),
  // adminDb chains
  tenantRow: vi.fn(),
  tierRow: vi.fn(),
  hostAdapterConfig: vi.fn(),
  feeConfig: vi.fn(),
  // side-effect mocks
  safeAwait: vi.fn().mockResolvedValue(null),
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  // adapter
  healthCheck: vi.fn(),
  submitBooking: vi.fn(),
  // dynamic imports
  assertNoEstimatedDOBs: vi.fn().mockResolvedValue(undefined),
  populateConversionTouch: vi.fn().mockResolvedValue(undefined),
  triggerMatchingSequences: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/http/idempotency", () => ({
  withIdempotencyKey: mocks.withIdempotencyKey,
}));

vi.mock("@/lib/db/safe-mutation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/safe-mutation")>(
    "@/lib/db/safe-mutation",
  );
  return { ...actual, safeAwait: mocks.safeAwait };
});

vi.mock("@/lib/audit/write", () => ({
  writeAuditLog: mocks.writeAuditLog,
}));

vi.mock("@/lib/booking/dob-gate", () => ({
  DOBEstimateUnresolvedError,
  assertNoEstimatedDOBs: mocks.assertNoEstimatedDOBs,
}));

vi.mock("@/lib/attribution/populate-conversion-touch", () => ({
  populateConversionTouch: mocks.populateConversionTouch,
}));

vi.mock("@/lib/tasks/sequence-engine", () => ({
  triggerMatchingSequences: mocks.triggerMatchingSequences,
}));

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      if (table === "bookings") {
        return {
          select: () => ({ eq: () => ({ single: mocks.bookingRead }) }),
          update: () => ({
            eq: () => ({
              // CAS lock: .update().eq(id).eq("status","draft").select("id")
              eq: () => ({ select: () => mocks.bookingCasLock() }),
              // safeAwait-wrapped single-eq updates — chain is never resolved
            }),
          }),
        };
      }
      if (table === "commissions") {
        return { insert: () => mocks.commissionsInsert() };
      }
      if (table === "quotes") {
        return { select: () => ({ eq: () => ({ maybeSingle: mocks.quotesMaybeSingle }) }) };
      }
      if (table === "tenant_host_fee_overrides") {
        return { select: () => ({ eq: () => ({ maybeSingle: mocks.tenantFeeOverride }) }) };
      }
      return {};
    },
  }),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "tenants") {
        return { select: () => ({ eq: () => ({ single: mocks.tenantRow }) }) };
      }
      if (table === "tier_definitions") {
        return { select: () => ({ eq: () => ({ single: mocks.tierRow }) }) };
      }
      if (table === "host_adapters") {
        return { select: () => ({ eq: () => ({ maybeSingle: mocks.hostAdapterConfig }) }) };
      }
      if (table === "host_booking_fee_configs") {
        return { select: () => ({ eq: () => ({ maybeSingle: mocks.feeConfig }) }) };
      }
      // platform_revenue inserts go to safeAwait — chain shape doesn't matter
      return { insert: () => ({}) };
    },
  }),
}));

vi.mock("@/lib/host-adapters/select-adapter", () => ({
  selectAdapterForCall: vi.fn().mockImplementation(() =>
    Promise.resolve({
      adapter: {
        adapterId: "mock-adapter",
        capabilities: { supports_commission_api: true },
        healthCheck: mocks.healthCheck,
        submitBooking: mocks.submitBooking,
      },
      ctx: { tenant_id: TENANT_ID, user_id: null, correlation_id: "test-corr" },
    }),
  ),
}));

import { POST } from "@/app/api/bookings/[id]/submit/route";

const PARAMS = { params: Promise.resolve({ id: BOOKING_ID }) };

function makeReq(): Request {
  return new Request(`https://example.com/api/bookings/${BOOKING_ID}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

const BASE_BOOKING = {
  id: BOOKING_ID,
  tenant_id: TENANT_ID,
  status: "draft",
  host_adapter: null,
  commissionable_fare_cents: BigInt(500000),
  total_amount_cents: BigInt(600000),
  currency: "USD",
  cruise_line: "Royal Caribbean",
  ship_name: "Harmony",
  sailing_date: "2026-12-01",
  duration_nights: 7,
  cabin_category: "Balcony",
  primary_contact_id: "cccc-contact",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID },
    user: { id: USER_ID },
  });

  mocks.bookingRead.mockResolvedValue({ data: BASE_BOOKING, error: null });

  // CAS lock succeeds by default (booking transitions draft → submitting)
  mocks.bookingCasLock.mockResolvedValue({ data: [{ id: BOOKING_ID }], error: null });

  mocks.assertNoEstimatedDOBs.mockResolvedValue(undefined);

  mocks.tenantRow.mockResolvedValue({
    // #1190: the real column is tenant_type (not prong) — keying the mock on it
    // guards against the reader reverting to the non-existent prong column.
    data: { id: TENANT_ID, tenant_type: "nuo", tier_id: TIER_ID, is_sandbox: false },
    error: null,
  });

  mocks.tierRow.mockResolvedValue({
    data: { id: TIER_ID, platform_split_rate: 0.25, hold_period_days: 30 },
    error: null,
  });

  mocks.healthCheck.mockResolvedValue({ ok: true });

  mocks.hostAdapterConfig.mockResolvedValue({
    data: { config: { default_commission_rate: 0.10 } },
    error: null,
  });

  mocks.feeConfig.mockResolvedValue({ data: null, error: null });
  mocks.tenantFeeOverride.mockResolvedValue({ data: null, error: null });
  mocks.quotesMaybeSingle.mockResolvedValue({ data: null, error: null });

  mocks.submitBooking.mockResolvedValue({
    ok: true,
    value: { provider_booking_ref: "PBR-TEST-001" },
  });

  mocks.commissionsInsert.mockResolvedValue({ data: null, error: null });
  mocks.populateConversionTouch.mockResolvedValue(undefined);
  mocks.triggerMatchingSequences.mockResolvedValue(undefined);
  mocks.writeAuditLog.mockResolvedValue(undefined);
  mocks.safeAwait.mockResolvedValue(null);
});

// ── Auth ──────────────────────────────────────────────────────────────────

describe("POST /api/bookings/[id]/submit — auth gate", () => {
  it("returns 401 when assertPermission throws (missing Bearer token)", async () => {
    mocks.assertPermission.mockRejectedValue(
      new Error("assertPermission: missing Authorization Bearer token"),
    );
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toBe("unauthorized");
  });
});

// ── Booking lookup ────────────────────────────────────────────────────────

describe("POST /api/bookings/[id]/submit — booking lookup", () => {
  it("returns 404 when booking is not found", async () => {
    mocks.bookingRead.mockResolvedValue({ data: null, error: { message: "not found" } });
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe("Booking not found.");
  });

  it("returns 422 when booking status is not 'draft'", async () => {
    mocks.bookingRead.mockResolvedValue({
      data: { ...BASE_BOOKING, status: "submitted" },
      error: null,
    });
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(422);
    expect((await res.json() as { error: string }).error).toBe("Only draft bookings can be submitted.");
  });
});

// ── CAS lock ─────────────────────────────────────────────────────────────

describe("POST /api/bookings/[id]/submit — CAS lock (§D-091 Round-3 #51)", () => {
  it("returns 409 when CAS update matches 0 rows (concurrent submit in flight)", async () => {
    // A concurrent submission already set status='submitting', so the
    // .update().eq("status","draft") update sees no matching row.
    mocks.bookingCasLock.mockResolvedValue({ data: [], error: null });
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/already in flight/);
  });
});

// ── DOB gate ─────────────────────────────────────────────────────────────

describe("POST /api/bookings/[id]/submit — DOB gate (§20.5)", () => {
  it("returns 409 with affected_passengers when DOBs are still estimated", async () => {
    const err = new DOBEstimateUnresolvedError(["Alice Smith", "Bob Smith"]);
    mocks.assertNoEstimatedDOBs.mockRejectedValue(err);
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; affected_passengers: string[] };
    expect(body.error).toBe("estimated_dob_unresolved");
    expect(body.affected_passengers).toEqual(["Alice Smith", "Bob Smith"]);
  });
});

// ── Tenant lookup ─────────────────────────────────────────────────────────

describe("POST /api/bookings/[id]/submit — tenant lookup (fail-closed)", () => {
  it("returns 500 when tenant row is missing — never defaults sandbox to false", async () => {
    mocks.tenantRow.mockResolvedValue({ data: null, error: { message: "no row" } });
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("tenant_lookup_failed");
  });
});

// ── Commission rate resolution ────────────────────────────────────────────

describe("POST /api/bookings/[id]/submit — commission rate (§14.4 fail-closed)", () => {
  it("returns 503 + pending_host_review when adapter is unhealthy (commission_rate unresolvable)", async () => {
    mocks.healthCheck.mockResolvedValue({ ok: false });
    // Adapter unhealthy → commission_rate stays null → fail-closed path
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(503);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("pending_host_review");
    // Verify audit log was written for the resolution failure
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking.commission_rate_resolution" }),
    );
  });

  it("returns 503 + pending_host_review when no adapter config row exists", async () => {
    mocks.hostAdapterConfig.mockResolvedValue({ data: null, error: null });
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(503);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("pending_host_review");
  });
});

// ── Platform split rate ───────────────────────────────────────────────────

describe("POST /api/bookings/[id]/submit — platform split rate (§14.4 fail-closed)", () => {
  it("returns 503 + pending_host_review when tenant has no tier_id", async () => {
    mocks.tenantRow.mockResolvedValue({
      data: { id: TENANT_ID, prong: "nuo", tier_id: null, is_sandbox: false },
      error: null,
    });
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(503);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("pending_host_review");
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: expect.objectContaining({ reason: "missing_platform_split" }),
      }),
    );
  });
});

// ── Host adapter submission ───────────────────────────────────────────────

describe("POST /api/bookings/[id]/submit — host adapter failure", () => {
  it("returns 502 and reverts CAS lock to 'draft' so the booking can be retried", async () => {
    mocks.submitBooking.mockResolvedValue({
      ok: false,
      error: { message: "host timeout", code: "TIMEOUT" },
    });

    const res = await POST(makeReq(), PARAMS);

    expect(res.status).toBe(502);
    const body = await res.json() as { error: string; code: string };
    expect(body.error).toContain("host timeout");

    // CAS revert: safeAwait called with the revert label
    expect(mocks.safeAwait).toHaveBeenCalledWith(
      expect.anything(),
      "bookings.update.revert_lock_on_host_failure",
    );
  });
});

// ── Commission insert failure ─────────────────────────────────────────────

describe("POST /api/bookings/[id]/submit — commission record", () => {
  it("returns 500 when commissions.insert fails", async () => {
    mocks.commissionsInsert.mockResolvedValue({ data: null, error: { message: "constraint violation" } });
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(500);
    expect((await res.json() as { error: string }).error).toMatch(/commission/i);
  });
});

// ── Sandbox ───────────────────────────────────────────────────────────────

describe("POST /api/bookings/[id]/submit — sandbox (§15.12)", () => {
  it("skips commissions row for sandbox tenants but still returns submitted", async () => {
    mocks.tenantRow.mockResolvedValue({
      data: { id: TENANT_ID, prong: "nuo", tier_id: TIER_ID, is_sandbox: true },
      error: null,
    });
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("submitted");
    // Commissions insert must NOT be called for sandbox tenants
    expect(mocks.commissionsInsert).not.toHaveBeenCalled();
  });
});

// ── Happy path ────────────────────────────────────────────────────────────

describe("POST /api/bookings/[id]/submit — happy path", () => {
  it("creates commissions row, transitions to submitted, returns provider_booking_ref", async () => {
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; status: string; provider_booking_ref: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("submitted");
    expect(body.provider_booking_ref).toBe("PBR-TEST-001");

    // Commission row must be written
    expect(mocks.commissionsInsert).toHaveBeenCalledTimes(1);

    // Booking updated to submitted via safeAwait
    expect(mocks.safeAwait).toHaveBeenCalledWith(
      expect.anything(),
      "bookings.update",
    );

    // Audit log written with resolution outcome = success
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: expect.objectContaining({ outcome: "success" }),
      }),
    );
  });

  it("§35.6 — triggers attribution touch when booking has a contact", async () => {
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(200);
    expect(mocks.populateConversionTouch).toHaveBeenCalledWith(
      expect.objectContaining({ contact_id: "cccc-contact" }),
    );
  });

  it("§37.4.2 — triggers booking_confirmed sequences after submit", async () => {
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(200);
    expect(mocks.triggerMatchingSequences).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "booking_confirmed" }),
    );
  });

  it("does NOT trigger attribution touch when booking has no primary_contact_id", async () => {
    mocks.bookingRead.mockResolvedValue({
      data: { ...BASE_BOOKING, primary_contact_id: null },
      error: null,
    });
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(200);
    expect(mocks.populateConversionTouch).not.toHaveBeenCalled();
  });
});
