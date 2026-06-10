// Cross-tenant booking ownership check — #715
//
// POST /api/bookings/[id]/resources must return 404 when the booking UUID
// belongs to a different tenant. Pre-fix: the route skipped the ownership
// check and would attempt to create trip_resources for any UUID, allowing
// cross-tenant resource creation.

import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingRow: null as { id: string } | null,
  bookingError: null as { message: string } | null,
  existingResource: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => ({
    ctx: { tenant_id: "t-owner" },
    user: { id: "u-1" },
  })),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => {
              if (table === "bookings") {
                return { data: mocks.bookingRow, error: mocks.bookingError };
              }
              // trip_resources idempotency check
              return { data: mocks.existingResource, error: null };
            },
            single: async () => ({ data: null, error: { message: "no row" } }),
          }),
          single: async () => ({ data: null, error: { message: "no row" } }),
        }),
      }),
      insert: () => ({
        select: () => ({
          single: async () => ({ data: { id: "tr-1", booking_id: "b-1", tenant_id: "t-owner" }, error: null }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/deliverables/tier-gate", () => ({
  assertDeliverablesAvailable: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/deliverables/token", () => ({
  newAccessToken: () => "tok-test",
}));

const { POST } = await import("@/app/api/bookings/[id]/resources/route");

function makeReq(bookingId: string): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`http://localhost/api/bookings/${bookingId}/resources`, { method: "POST" }),
    { params: Promise.resolve({ id: bookingId }) },
  ];
}

describe("POST /api/bookings/[id]/resources — ownership check (#715)", () => {
  it("returns 404 when booking does not belong to the current tenant", async () => {
    mocks.bookingRow = null; // no row matching (tenant_id + booking_id) combo
    mocks.bookingError = null;
    mocks.existingResource = null;

    const res = await POST(...makeReq("b-other-tenant"));
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("returns 200 for idempotent request when booking is owned by tenant", async () => {
    mocks.bookingRow = { id: "b-1" }; // booking exists and belongs to tenant
    mocks.bookingError = null;
    mocks.existingResource = { id: "tr-1", booking_id: "b-1" };

    const res = await POST(...makeReq("b-1"));
    expect(res.status).toBe(200);
    const body = await res.json() as { created: boolean };
    expect(body.created).toBe(false);
  });

  it("returns 500 when booking lookup fails with a DB error", async () => {
    mocks.bookingRow = null;
    mocks.bookingError = { message: "connection failed" };
    mocks.existingResource = null;

    const res = await POST(...makeReq("b-1"));
    expect(res.status).toBe(500);
  });
});
