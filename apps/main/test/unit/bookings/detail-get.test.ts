// §7.6 — GET /api/bookings/[id] (booking detail).
//
// #1190 regression: this route shipped reading three columns that don't exist
// on bookings — host_booking_reference, ai_paused_by_platform, is_test — so
// every detail fetch 400'd at PostgREST. The real columns are
// provider_booking_ref and is_sandbox (ai_paused_by_platform is a tenants
// column and was never surfaced here). The response still exposes the values
// under host_booking_reference / is_test for the detail UI, so the contract is
// pinned here: a DB row keyed on the REAL columns must map to those response
// keys. Reverting the reader/serializer to the wrong columns breaks this test
// (and the column-reader gate).

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const BOOKING_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  bookingMaybeSingle: vi.fn(),
  contactMaybeSingle: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      if (table === "bookings") {
        return { select: () => ({ eq: () => ({ maybeSingle: mocks.bookingMaybeSingle }) }) };
      }
      // contacts
      return { select: () => ({ eq: () => ({ maybeSingle: mocks.contactMaybeSingle }) }) };
    },
  }),
}));

import { GET } from "@/app/api/bookings/[id]/route";

const PARAMS = { params: Promise.resolve({ id: BOOKING_ID }) };

function makeReq(): Request {
  return new Request(`https://example.com/api/bookings/${BOOKING_ID}`);
}

// A bookings row as PostgREST returns it after the corrected select: the REAL
// columns provider_booking_ref + is_sandbox, never host_booking_reference/is_test.
const REAL_ROW = {
  id: BOOKING_ID,
  tenant_id: TENANT_ID,
  status: "confirmed",
  cruise_line: "Royal Caribbean",
  ship_name: "Harmony",
  sailing_date: "2026-12-01",
  duration_nights: 7,
  cabin_category: "Balcony",
  departure_port: "Miami",
  total_amount_cents: 600000,
  commissionable_fare_cents: 500000,
  currency: "USD",
  primary_contact_id: "cccc-contact",
  host_adapter: "nuo",
  provider_booking_ref: "HOST-REF-123",
  is_sandbox: true,
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-02T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.assertPermission.mockResolvedValue({ ctx: { tenant_id: TENANT_ID } });
  mocks.bookingMaybeSingle.mockResolvedValue({ data: REAL_ROW, error: null });
  mocks.contactMaybeSingle.mockResolvedValue({
    data: { id: "cccc-contact", first_name: "Jordan", last_name: "Lee", email: "j@example.com" },
    error: null,
  });
});

describe("GET /api/bookings/[id] — #1190 column mapping", () => {
  it("maps provider_booking_ref → host_booking_reference and is_sandbox → is_test in the response", async () => {
    const res = await GET(makeReq(), PARAMS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { booking: Record<string, unknown> };

    // The values must surface under the response keys the detail UI consumes.
    expect(body.booking.host_booking_reference).toBe("HOST-REF-123");
    expect(body.booking.is_test).toBe(true);

    // The raw DB column names must NOT leak into the response, and the dropped
    // tenants column must be absent.
    expect(body.booking).not.toHaveProperty("provider_booking_ref");
    expect(body.booking).not.toHaveProperty("is_sandbox");
    expect(body.booking).not.toHaveProperty("ai_paused_by_platform");
  });

  it("returns the primary contact alongside the booking", async () => {
    const res = await GET(makeReq(), PARAMS);
    const body = (await res.json()) as { primary_contact: { email: string } | null };
    expect(body.primary_contact?.email).toBe("j@example.com");
  });

  it("404s when the booking is absent", async () => {
    mocks.bookingMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await GET(makeReq(), PARAMS);
    expect(res.status).toBe(404);
  });
});
