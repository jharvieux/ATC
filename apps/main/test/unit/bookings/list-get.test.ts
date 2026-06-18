// §7.6 — GET /api/bookings (list).
//
// #1190 regression: the list route selected is_test, which is not a bookings
// column (the sandbox flag is is_sandbox), so the list query 400'd. The fix
// reads is_sandbox and still exposes it as is_test in the response. This test
// pins that mapping: a DB row with is_sandbox=true must surface as is_test=true.
// A revert to reading b.is_test resolves to undefined → is_test:false here.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  bookingsRange: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

// No contact_query and no status filter → the route goes straight to the
// bookings query: .from("bookings").select(...).order(...).range(...). A booking
// row with primary_contact_id=null skips the contacts batch lookup.
vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      if (table === "bookings") {
        return {
          select: () => ({ order: () => ({ range: mocks.bookingsRange }) }),
        };
      }
      throw new Error(`unexpected tenantClient.from("${table}")`);
    },
  }),
}));

import { GET } from "@/app/api/bookings/route";

function listReq(): Request {
  return new Request("https://tenant.example.com/api/bookings", { method: "GET" });
}

const SANDBOX_ROW = {
  id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  status: "confirmed",
  cruise_line: "Royal Caribbean",
  ship_name: "Harmony",
  sailing_date: "2026-12-01",
  duration_nights: 7,
  total_amount_cents: 600000,
  currency: "USD",
  primary_contact_id: null,
  is_sandbox: true,
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-02T00:00:00Z",
  cruise_line_id: null,
  cruise_lines: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID, source: { kind: "http_request", user_id: "u1" } },
  });
  mocks.bookingsRange.mockResolvedValue({ data: [SANDBOX_ROW], error: null, count: 1 });
});

describe("GET /api/bookings — #1190 is_sandbox → is_test mapping", () => {
  it("exposes the sandbox flag as is_test=true in the response", async () => {
    const res = await GET(listReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bookings: Array<{ is_test: boolean }> };
    expect(body.bookings).toHaveLength(1);
    expect(body.bookings[0]?.is_test).toBe(true);
  });
});
