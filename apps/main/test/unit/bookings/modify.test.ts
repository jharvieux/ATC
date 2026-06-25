// §20.9 — POST /api/bookings/[id]/modify.
//
// Covers: auth gate, booking-not-found, wrong-status gate (only "confirmed"),
// missing-body-fields, tenant-lookup-fail, adapter-capability gate,
// adapter failure → 502, and happy-path → 200.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Constants defined before vi.hoisted() so they are available in the factory.
// (In practice vi.hoisted() runs before any top-level statements, so constants
// referenced inside it must be moved here as well.)
const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const BOOKING_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const mocks = vi.hoisted(() => {
  const adapterInstance = {
    adapterId: "mock-adapter",
    capabilities: { supports_modification: true },
    modifyBooking: vi.fn(),
  };
  return {
    assertPermission: vi.fn(),
    bookingMaybeSingle: vi.fn(),
    tenantSingle: vi.fn(),
    safeAwait: vi.fn().mockResolvedValue(null),
    selectAdapterForCall: vi.fn().mockResolvedValue({
      adapter: adapterInstance,
      // Literal string — can't reference TENANT_ID from hoisted context
      ctx: { tenant_id: "11111111-2222-3333-4444-555555555555", user_id: null, correlation_id: "test-corr" },
    }),
    adapterInstance,
  };
});

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "bookings") {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: mocks.bookingMaybeSingle }) }) }),
          // safeAwait-wrapped post-modify update — chain must not throw synchronously
          update: () => ({ eq: () => ({ eq: () => ({}) }) }),
        };
      }
      if (table === "tenants") {
        return { select: () => ({ eq: () => ({ single: mocks.tenantSingle }) }) };
      }
      return {};
    },
  }),
}));

vi.mock("@/lib/db/safe-mutation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/safe-mutation")>(
    "@/lib/db/safe-mutation",
  );
  return { ...actual, safeAwait: mocks.safeAwait };
});

vi.mock("@/lib/host-adapters/select-adapter", () => ({
  selectAdapterForCall: mocks.selectAdapterForCall,
}));

import { POST } from "@/app/api/bookings/[id]/modify/route";

function makeReq(body: unknown = { field: "cabin_category", new_value: "Balcony" }): Request {
  return new Request(`https://example.com/api/bookings/${BOOKING_ID}/modify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PARAMS = { params: Promise.resolve({ id: BOOKING_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});

  mocks.assertPermission.mockResolvedValue({ ctx: { tenant_id: TENANT_ID } });

  mocks.bookingMaybeSingle.mockResolvedValue({
    data: {
      id: BOOKING_ID,
      tenant_id: TENANT_ID,
      status: "confirmed",
      provider_booking_ref: "PBR-001",
      host_adapter: "mock-adapter",
    },
    error: null,
  });

  mocks.tenantSingle.mockResolvedValue({
    // #1190: the real column is tenant_type (not prong).
    data: { tenant_type: "nuo", is_sandbox: false },
    error: null,
  });

  // vi.clearAllMocks() wipes implementations — restore them each test.
  mocks.safeAwait.mockResolvedValue(null);
  mocks.selectAdapterForCall.mockResolvedValue({
    adapter: mocks.adapterInstance,
    ctx: { tenant_id: TENANT_ID, user_id: null, correlation_id: "test-corr" },
  });
  mocks.adapterInstance.modifyBooking.mockResolvedValue({
    ok: true,
    value: { confirmation: "modified" },
  });
});

describe("POST /api/bookings/[id]/modify — auth gate", () => {
  it("returns 401 when assertPermission throws", async () => {
    mocks.assertPermission.mockRejectedValue(
      new Error("assertPermission: missing Authorization Bearer token"),
    );
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/bookings/[id]/modify — booking lookup", () => {
  it("returns 404 when booking not found", async () => {
    mocks.bookingMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe("booking_not_found");
  });

  it("returns 409 when booking status is not 'confirmed'", async () => {
    mocks.bookingMaybeSingle.mockResolvedValue({
      data: { id: BOOKING_ID, tenant_id: TENANT_ID, status: "draft", provider_booking_ref: null, host_adapter: null },
      error: null,
    });
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; status: string };
    expect(body.error).toBe("booking_not_modifiable");
    expect(body.status).toBe("draft");
  });

  it("returns 409 for 'submitted' status (not yet confirmed)", async () => {
    mocks.bookingMaybeSingle.mockResolvedValue({
      data: { id: BOOKING_ID, tenant_id: TENANT_ID, status: "submitted", provider_booking_ref: null, host_adapter: null },
      error: null,
    });
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(409);
  });
});

describe("POST /api/bookings/[id]/modify — body validation", () => {
  it("returns 400 when field is missing", async () => {
    const res = await POST(makeReq({ new_value: "Balcony" }), PARAMS);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("field_and_new_value_required");
  });

  it("returns 400 when new_value is missing", async () => {
    const res = await POST(makeReq({ field: "cabin_category" }), PARAMS);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("field_and_new_value_required");
  });
});

describe("POST /api/bookings/[id]/modify — tenant lookup", () => {
  it("returns 500 when tenant row is missing (fail-closed — prevents sandbox bypass)", async () => {
    mocks.tenantSingle.mockResolvedValue({ data: null, error: { message: "row not found" } });
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("db_error");
  });
});

describe("POST /api/bookings/[id]/modify — adapter capability gate", () => {
  it("returns 409 when adapter does not support modification", async () => {
    // Override per-test so shared adapterInstance is never mutated (a failed
    // assertion between set and restore would leave it broken for later tests).
    mocks.selectAdapterForCall.mockResolvedValueOnce({
      adapter: { ...mocks.adapterInstance, capabilities: { supports_modification: false } },
      ctx: { tenant_id: TENANT_ID, user_id: null, correlation_id: "test-corr" },
    });
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; adapter: string };
    expect(body.error).toBe("adapter_does_not_support_modification");
    expect(body.adapter).toBe("mock-adapter");
  });
});

describe("POST /api/bookings/[id]/modify — adapter failure", () => {
  it("returns 502 when adapter.modifyBooking reports failure", async () => {
    mocks.adapterInstance.modifyBooking.mockResolvedValue({
      ok: false,
      error: { message: "host error", code: "HOST_ERR" },
    });
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string; code: string };
    expect(body.error).toBe("adapter_modify_failed");
    expect(body.code).toBe("HOST_ERR");
  });
});

describe("POST /api/bookings/[id]/modify — happy path", () => {
  it("returns 200 with adapter_response and updates booking status", async () => {
    const res = await POST(makeReq(), PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; adapter_response: unknown };
    expect(body.ok).toBe(true);
    expect(body.adapter_response).toEqual({ confirmation: "modified" });
    expect(mocks.safeAwait).toHaveBeenCalledWith(
      expect.anything(),
      "bookings.update",
    );
    // #1190 regression: prong passed to the adapter selector comes from the real
    // tenants.tenant_type column. A revert to tenant.prong passes undefined.
    expect(mocks.selectAdapterForCall).toHaveBeenCalledWith(
      expect.objectContaining({ prong: "nuo" }),
      expect.anything(),
    );
  });
});
