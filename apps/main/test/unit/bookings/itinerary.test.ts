// §39.2 — GET + POST /api/bookings/[id]/itinerary.
//
// Covers: auth gate, tier gate (GET and POST), booking-not-found,
// idempotent return of existing itinerary, happy-path create → 201.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const BOOKING_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  deliverablesGate: vi.fn(),
  bookingMaybeSingle: vi.fn(),
  itineraryMaybeSingle: vi.fn(),
  itineraryInsertSingle: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/deliverables/tier-gate", () => ({
  assertDeliverablesAvailable: mocks.deliverablesGate,
}));

vi.mock("@/lib/deliverables/token", () => ({
  newAccessToken: () => "test-token-abc",
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "bookings") {
        return { select: () => ({ eq: () => ({ maybeSingle: mocks.bookingMaybeSingle }) }) };
      }
      if (table === "trip_itineraries") {
        // Supports both the read path (.select().eq().maybeSingle()) and
        // write path (.insert().select().single()).
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: mocks.itineraryMaybeSingle }),
              // plain .maybeSingle() — idempotent read inside POST
              maybeSingle: mocks.itineraryMaybeSingle,
            }),
          }),
          insert: () => ({
            select: () => ({ single: mocks.itineraryInsertSingle }),
          }),
        };
      }
      return {};
    },
  }),
}));

import { GET, POST } from "@/app/api/bookings/[id]/itinerary/route";

const PARAMS = { params: Promise.resolve({ id: BOOKING_ID }) };

function makeReq(method: "GET" | "POST" = "GET"): Request {
  return new Request(`https://example.com/api/bookings/${BOOKING_ID}/itinerary`, { method });
}

const EXISTING_ITINERARY = {
  id: "itin-1",
  booking_id: BOOKING_ID,
  tenant_id: TENANT_ID,
  status: "draft",
  access_token: "token-xyz",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});

  mocks.assertPermission.mockResolvedValue({ ctx: { tenant_id: TENANT_ID } });
  mocks.deliverablesGate.mockResolvedValue({ ok: true });

  mocks.bookingMaybeSingle.mockResolvedValue({
    data: { id: BOOKING_ID, tenant_id: TENANT_ID },
    error: null,
  });
  mocks.itineraryMaybeSingle.mockResolvedValue({ data: null, error: null });
  mocks.itineraryInsertSingle.mockResolvedValue({
    data: { ...EXISTING_ITINERARY, access_token: "test-token-abc" },
    error: null,
  });
});

describe("GET /api/bookings/[id]/itinerary — auth gate", () => {
  it("returns 401 when assertPermission throws", async () => {
    mocks.assertPermission.mockRejectedValue(new Error("assertPermission: missing Authorization Bearer token"));
    const res = await GET(makeReq(), PARAMS);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/bookings/[id]/itinerary — read", () => {
  it("returns { itinerary: null } when no itinerary exists yet", async () => {
    mocks.itineraryMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await GET(makeReq(), PARAMS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ itinerary: null });
  });

  it("returns existing itinerary when one exists", async () => {
    mocks.itineraryMaybeSingle.mockResolvedValue({ data: EXISTING_ITINERARY, error: null });
    const res = await GET(makeReq(), PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json() as { itinerary: unknown }).itinerary).toMatchObject({ id: "itin-1" });
  });
});

describe("POST /api/bookings/[id]/itinerary — auth gate", () => {
  it("returns 401 when assertPermission throws", async () => {
    mocks.assertPermission.mockRejectedValue(new Error("assertPermission: missing Authorization Bearer token"));
    const res = await POST(makeReq("POST"), PARAMS);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/bookings/[id]/itinerary — tier gate", () => {
  it("returns 403 when deliverables tier gate is blocked", async () => {
    mocks.deliverablesGate.mockResolvedValue({ ok: false, reason: "tier_too_low" });
    const res = await POST(makeReq("POST"), PARAMS);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("tier_too_low");
  });
});

describe("POST /api/bookings/[id]/itinerary — booking scope check", () => {
  it("returns 404 when booking belongs to a different tenant", async () => {
    mocks.bookingMaybeSingle.mockResolvedValue({
      data: { id: BOOKING_ID, tenant_id: "other-tenant" },
      error: null,
    });
    const res = await POST(makeReq("POST"), PARAMS);
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe("booking_not_found");
  });

  it("returns 404 when booking row is missing", async () => {
    mocks.bookingMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await POST(makeReq("POST"), PARAMS);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/bookings/[id]/itinerary — idempotency", () => {
  it("returns existing itinerary with created:false when itinerary already exists", async () => {
    mocks.itineraryMaybeSingle.mockResolvedValue({ data: EXISTING_ITINERARY, error: null });
    const res = await POST(makeReq("POST"), PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json() as { itinerary: unknown; created: boolean };
    expect(body.created).toBe(false);
    expect(body.itinerary).toMatchObject({ id: "itin-1" });
    // Insert must NOT be called when returning the existing row
    expect(mocks.itineraryInsertSingle).not.toHaveBeenCalled();
  });
});

describe("POST /api/bookings/[id]/itinerary — happy path", () => {
  it("creates a draft itinerary, returns 201 with created:true", async () => {
    const res = await POST(makeReq("POST"), PARAMS);
    expect(res.status).toBe(201);
    const body = await res.json() as { itinerary: { status: string; access_token: string }; created: boolean };
    expect(body.created).toBe(true);
    expect(body.itinerary.status).toBe("draft");
    expect(body.itinerary.access_token).toBe("test-token-abc");
  });
});
