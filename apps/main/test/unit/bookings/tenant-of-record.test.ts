// §20.7 — GET /api/bookings/[id]/tenant-of-record.
//
// #1856 regression: the booking Review stage previously hardcoded
// "Your Agency" / "support@youragency.com" / "Host Agency" instead of reading
// the real sub-host tenant and platform host-agency legal name. This pins the
// route's contract so a future revert back to stub data fails loudly, and
// covers the platform_settings bare-string-vs-{value} unwrap plus the
// booking-not-found (cross-tenant) gate.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const BOOKING_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  bookingMaybeSingle: vi.fn(),
  tenantMaybeSingle: vi.fn(),
  settingMaybeSingle: vi.fn(),
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
      if (table === "tenants") {
        return { select: () => ({ eq: () => ({ maybeSingle: mocks.tenantMaybeSingle }) }) };
      }
      // platform_settings
      return { select: () => ({ eq: () => ({ maybeSingle: mocks.settingMaybeSingle }) }) };
    },
  }),
}));

import { GET } from "@/app/api/bookings/[id]/tenant-of-record/route";

const PARAMS = { params: Promise.resolve({ id: BOOKING_ID }) };

function makeReq(): Request {
  return new Request(`https://example.com/api/bookings/${BOOKING_ID}/tenant-of-record`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({ ctx: { tenant_id: TENANT_ID } });
  mocks.bookingMaybeSingle.mockResolvedValue({ data: { id: BOOKING_ID }, error: null });
  mocks.tenantMaybeSingle.mockResolvedValue({
    data: { display_name: "Coral Cove Travel", support_email: "help@coralcove.example" },
    error: null,
  });
  mocks.settingMaybeSingle.mockResolvedValue({ data: { value: "Wavecrest Host Agency LLC" }, error: null });
});

describe("GET /api/bookings/[id]/tenant-of-record (#1856)", () => {
  it("returns the real tenant and host-agency records, never the placeholder strings", async () => {
    const res = await GET(makeReq(), PARAMS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenant: { name: string; support_email: string };
      host_agency: { legal_name: string };
    };

    expect(body.tenant.name).toBe("Coral Cove Travel");
    expect(body.tenant.support_email).toBe("help@coralcove.example");
    expect(body.host_agency.legal_name).toBe("Wavecrest Host Agency LLC");

    // The regression this test guards against: a stub/placeholder revert.
    expect(body.tenant.name).not.toBe("Your Agency");
    expect(body.tenant.support_email).not.toBe("support@youragency.com");
    expect(body.host_agency.legal_name).not.toBe("Host Agency");
  });

  it("unwraps a platform_settings value stored as a JSON object with .value", async () => {
    mocks.settingMaybeSingle.mockResolvedValue({ data: { value: { value: "Nested Host LLC" } }, error: null });
    const res = await GET(makeReq(), PARAMS);
    const body = (await res.json()) as { host_agency: { legal_name: string } };
    expect(body.host_agency.legal_name).toBe("Nested Host LLC");
  });

  it("404s instead of returning tenant data when the booking isn't in the caller's tenant", async () => {
    mocks.bookingMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await GET(makeReq(), PARAMS);
    expect(res.status).toBe(404);
    expect(mocks.tenantMaybeSingle).not.toHaveBeenCalled();
  });

  // Audit finding on #1856: a missing platform_settings row (or a null
  // tenant.display_name) must never resolve to the "Host Agency" /
  // "Sub-host" placeholder strings — that's a fail-open disclosure that lets
  // a customer confirm a booking under a fabricated legal name. The route
  // must surface null so the client can fail closed instead.
  it("returns null (never a placeholder) when the host-agency setting row is missing", async () => {
    mocks.settingMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.tenantMaybeSingle.mockResolvedValue({ data: { display_name: null, support_email: null }, error: null });

    const res = await GET(makeReq(), PARAMS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenant: { name: string | null; support_email: string };
      host_agency: { legal_name: string | null };
    };

    expect(body.host_agency.legal_name).toBeNull();
    expect(body.tenant.name).toBeNull();
    expect(body.host_agency.legal_name).not.toBe("Host Agency");
    expect(body.tenant.name).not.toBe("Sub-host");
  });

  it("returns null when platform_settings.value is a JSON object without a string .value", async () => {
    mocks.settingMaybeSingle.mockResolvedValue({ data: { value: {} }, error: null });
    const res = await GET(makeReq(), PARAMS);
    const body = (await res.json()) as { host_agency: { legal_name: string | null } };
    expect(body.host_agency.legal_name).toBeNull();
    expect(body.host_agency.legal_name).not.toBe("Host Agency");
  });
});
