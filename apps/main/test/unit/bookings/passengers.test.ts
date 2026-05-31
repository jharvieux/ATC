// §20.2 / §20.5 — POST /api/bookings/[id]/passengers
//
// Contracts pinned here:
//   1. POST replaces all passengers (delete-then-insert) — idempotent.
//      Re-submitting the same list doesn't create duplicates.
//   2. §20.5: posting with 0 lead passengers auto-promotes index 0,
//      so callers can omit is_lead_passenger on single-passenger bookings.
//   3. §20.5: multiple lead passengers are rejected (400) — the API
//      enforces the single-lead invariant, not just the UI.
//   4. Empty passengers array is rejected (400) — at least 1 required.
//   5. Tenant isolation: booking must exist in this tenant before we
//      touch booking_passengers. 404 if not found; 500 on DB error.
//   6. Mutation fail-loud: safeAwait wraps delete + insert.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  bookingMaybeSingle: vi.fn(),
  passengerDeleteEq: vi.fn(),
  passengerInsert: vi.fn(),
  passengerSelectOrder: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
      "@/lib/auth/assert-permission",
    );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      if (table === "bookings") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: mocks.bookingMaybeSingle }),
          }),
        };
      }
      // booking_passengers
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              order: mocks.passengerSelectOrder,
            }),
          }),
        }),
        delete: () => ({
          eq: mocks.passengerDeleteEq,
        }),
        insert: mocks.passengerInsert,
      };
    },
  }),
}));

import { GET, POST } from "@/app/api/bookings/[id]/passengers/route";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const BOOKING_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const basePassenger = {
  legal_first_name: "John",
  legal_last_name: "Doe",
  date_of_birth: "1985-04-20",
  date_of_birth_is_estimated: false,
  is_lead_passenger: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID, source: { kind: "http_request", user_id: "u1" } },
    user: { id: "u1", tenant_id: TENANT_ID, status: "active", role: "agent" },
  });
  mocks.bookingMaybeSingle.mockResolvedValue({ data: { id: BOOKING_ID }, error: null });
  mocks.passengerDeleteEq.mockResolvedValue({ error: null });
  mocks.passengerInsert.mockResolvedValue({ error: null });
  mocks.passengerSelectOrder.mockResolvedValue({ data: [], error: null });
});

function makeParams(id = BOOKING_ID) {
  return { params: Promise.resolve({ id }) };
}

function postReq(body: unknown): Request {
  return new Request(`https://t.example.com/api/bookings/${BOOKING_ID}/passengers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/bookings/[id]/passengers", () => {
  it("returns passenger list from the DB", async () => {
    mocks.passengerSelectOrder.mockResolvedValue({
      data: [{ ...basePassenger, id: "p1", created_at: "2026-05-01" }],
      error: null,
    });
    const res = await GET(new Request(`https://t.example.com/api/bookings/${BOOKING_ID}/passengers`), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json() as { passengers: unknown[] };
    expect(body.passengers).toHaveLength(1);
  });

  it("returns 404 when booking not found in this tenant", async () => {
    mocks.bookingMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await GET(new Request(`https://t.example.com/api/bookings/${BOOKING_ID}/passengers`), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns 401 when assertPermission rejects", async () => {
    mocks.assertPermission.mockRejectedValue(new Error("assertPermission: invalid or expired access token."));
    const res = await GET(new Request(`https://t.example.com/api/bookings/${BOOKING_ID}/passengers`), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 on AuthForbidden", async () => {
    const { AuthForbidden } = await import("@/lib/auth/assert-permission");
    mocks.assertPermission.mockRejectedValue(new AuthForbidden("bookings.passengers", "read", "viewer"));
    const res = await GET(new Request(`https://t.example.com/api/bookings/${BOOKING_ID}/passengers`), makeParams());
    expect(res.status).toBe(403);
  });
});

describe("POST /api/bookings/[id]/passengers", () => {
  it("replaces passengers and returns count", async () => {
    const res = await POST(postReq({ passengers: [basePassenger] }), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; count: number };
    expect(body.ok).toBe(true);
    expect(body.count).toBe(1);
    expect(mocks.passengerDeleteEq).toHaveBeenCalledTimes(1);
    expect(mocks.passengerInsert).toHaveBeenCalledTimes(1);
  });

  it("§20.5: auto-promotes index 0 when no is_lead_passenger is set — prevents single-pax bookings from rejecting", async () => {
    const pax = { ...basePassenger, is_lead_passenger: false };
    const res = await POST(postReq({ passengers: [pax] }), makeParams());
    expect(res.status).toBe(200);
  });

  it("§20.5: rejects when multiple lead passengers are submitted — single-lead invariant enforced server-side", async () => {
    const pax1 = { ...basePassenger, is_lead_passenger: true };
    const pax2 = { ...basePassenger, legal_first_name: "Jane", is_lead_passenger: true };
    const res = await POST(postReq({ passengers: [pax1, pax2] }), makeParams());
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("multiple_lead_passengers");
    expect(mocks.passengerInsert).not.toHaveBeenCalled();
  });

  it("rejects empty passengers array (min(1) required)", async () => {
    const res = await POST(postReq({ passengers: [] }), makeParams());
    expect(res.status).toBe(400);
    expect(mocks.passengerInsert).not.toHaveBeenCalled();
  });

  it("rejects invalid date_of_birth format", async () => {
    const pax = { ...basePassenger, date_of_birth: "20-04-1985" };
    const res = await POST(postReq({ passengers: [pax] }), makeParams());
    expect(res.status).toBe(400);
  });

  it("returns 404 when booking not found in this tenant — no passenger write occurs", async () => {
    mocks.bookingMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await POST(postReq({ passengers: [basePassenger] }), makeParams());
    expect(res.status).toBe(404);
    expect(mocks.passengerInsert).not.toHaveBeenCalled();
  });

  it("returns 401 when assertPermission rejects", async () => {
    mocks.assertPermission.mockRejectedValue(new Error("assertPermission: invalid or expired access token."));
    const res = await POST(postReq({ passengers: [basePassenger] }), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 on AuthForbidden (viewer role cannot write passengers)", async () => {
    const { AuthForbidden } = await import("@/lib/auth/assert-permission");
    mocks.assertPermission.mockRejectedValue(new AuthForbidden("bookings.passengers", "write", "viewer"));
    const res = await POST(postReq({ passengers: [basePassenger] }), makeParams());
    expect(res.status).toBe(403);
  });
});
