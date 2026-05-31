// §20.2 — PUT /api/bookings/[id]/options
//
// Contracts pinned here:
//   1. PUT replaces all options (delete-then-insert) — sending an empty
//      options array is valid and clears all options. This is how Stage 3
//      submits when the customer selected nothing.
//   2. Tenant isolation: booking must exist in this tenant before we
//      touch booking_options. 404 if not found.
//   3. When options array is empty, the insert step is skipped entirely
//      (no DB call for zero rows).
//   4. Mutation fail-loud: safeAwait wraps delete.
//   5. option_value is an arbitrary JSON record — any unknown key passes.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  bookingMaybeSingle: vi.fn(),
  optionDeleteEq: vi.fn(),
  optionInsert: vi.fn(),
  optionSelectOrder: vi.fn(),
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
      // booking_options
      return {
        select: () => ({
          eq: () => ({
            order: mocks.optionSelectOrder,
          }),
        }),
        delete: () => ({
          eq: mocks.optionDeleteEq,
        }),
        insert: mocks.optionInsert,
      };
    },
  }),
}));

import { GET, PUT } from "@/app/api/bookings/[id]/options/route";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const BOOKING_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const baseOption = {
  option_kind: "travel_insurance",
  option_value: { label: "Travel Insurance" },
  price_cents: 14900,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID, source: { kind: "http_request", user_id: "u1" } },
    user: { id: "u1", tenant_id: TENANT_ID, status: "active", role: "agent" },
  });
  mocks.bookingMaybeSingle.mockResolvedValue({ data: { id: BOOKING_ID }, error: null });
  mocks.optionDeleteEq.mockResolvedValue({ error: null });
  mocks.optionInsert.mockResolvedValue({ error: null });
  mocks.optionSelectOrder.mockResolvedValue({ data: [], error: null });
});

function makeParams(id = BOOKING_ID) {
  return { params: Promise.resolve({ id }) };
}

function putReq(body: unknown): Request {
  return new Request(`https://t.example.com/api/bookings/${BOOKING_ID}/options`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/bookings/[id]/options", () => {
  it("returns options list from the DB", async () => {
    mocks.optionSelectOrder.mockResolvedValue({
      data: [{ id: "o1", option_kind: "travel_insurance", option_value: {}, price_cents: 14900, created_at: "2026-05-01" }],
      error: null,
    });
    const res = await GET(new Request(`https://t.example.com/api/bookings/${BOOKING_ID}/options`), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json() as { options: unknown[] };
    expect(body.options).toHaveLength(1);
  });

  it("returns empty array when no options have been selected", async () => {
    const res = await GET(new Request(`https://t.example.com/api/bookings/${BOOKING_ID}/options`), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json() as { options: unknown[] };
    expect(body.options).toHaveLength(0);
  });

  it("returns 404 when booking not found in this tenant", async () => {
    mocks.bookingMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await GET(new Request(`https://t.example.com/api/bookings/${BOOKING_ID}/options`), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns 401 when assertPermission rejects", async () => {
    mocks.assertPermission.mockRejectedValue(new Error("assertPermission: invalid or expired access token."));
    const res = await GET(new Request(`https://t.example.com/api/bookings/${BOOKING_ID}/options`), makeParams());
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/bookings/[id]/options", () => {
  it("replaces options and returns count", async () => {
    const res = await PUT(putReq({ options: [baseOption] }), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; count: number };
    expect(body.ok).toBe(true);
    expect(body.count).toBe(1);
    expect(mocks.optionDeleteEq).toHaveBeenCalledTimes(1);
    expect(mocks.optionInsert).toHaveBeenCalledTimes(1);
  });

  it("empty options array clears all — no insert call, delete still fires", async () => {
    const res = await PUT(putReq({ options: [] }), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; count: number };
    expect(body.ok).toBe(true);
    expect(body.count).toBe(0);
    expect(mocks.optionDeleteEq).toHaveBeenCalledTimes(1);
    expect(mocks.optionInsert).not.toHaveBeenCalled();
  });

  it("rejects negative price_cents", async () => {
    const res = await PUT(putReq({ options: [{ ...baseOption, price_cents: -1 }] }), makeParams());
    expect(res.status).toBe(400);
    expect(mocks.optionInsert).not.toHaveBeenCalled();
  });

  it("rejects empty option_kind", async () => {
    const res = await PUT(putReq({ options: [{ ...baseOption, option_kind: "" }] }), makeParams());
    expect(res.status).toBe(400);
  });

  it("returns 404 when booking not found in this tenant — no option write occurs", async () => {
    mocks.bookingMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await PUT(putReq({ options: [baseOption] }), makeParams());
    expect(res.status).toBe(404);
    expect(mocks.optionInsert).not.toHaveBeenCalled();
  });

  it("returns 401 when assertPermission rejects", async () => {
    mocks.assertPermission.mockRejectedValue(new Error("assertPermission: invalid or expired access token."));
    const res = await PUT(putReq({ options: [baseOption] }), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 on AuthForbidden (viewer role cannot write options)", async () => {
    const { AuthForbidden } = await import("@/lib/auth/assert-permission");
    mocks.assertPermission.mockRejectedValue(new AuthForbidden("bookings.options", "write", "viewer"));
    const res = await PUT(putReq({ options: [baseOption] }), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 500 when booking lookup DB errors — fail-loud, not silent 404", async () => {
    mocks.bookingMaybeSingle.mockResolvedValue({ data: null, error: { message: "rls failure" } });
    const res = await PUT(putReq({ options: [baseOption] }), makeParams());
    expect(res.status).toBe(500);
    expect(mocks.optionInsert).not.toHaveBeenCalled();
  });

  it("returns 500 when delete fails — safeAwait surfaces DB error via respondToAuthError", async () => {
    mocks.optionDeleteEq.mockResolvedValue({ error: { message: "permission denied", code: "42501" } });
    const res = await PUT(putReq({ options: [baseOption] }), makeParams());
    expect(res.status).toBe(500);
    expect(mocks.optionInsert).not.toHaveBeenCalled();
  });

  it("returns 500 when insert fails — safeAwait surfaces DB error via respondToAuthError", async () => {
    mocks.optionInsert.mockResolvedValue({ error: { message: "constraint violation", code: "23502" } });
    const res = await PUT(putReq({ options: [baseOption] }), makeParams());
    expect(res.status).toBe(500);
  });
});
