// #558 — GET /api/bookings must not let the user-supplied contact_query inject
// extra PostgREST OR conditions or live SQL wildcards into the contacts lookup.
// This captures the exact string handed to `.or()` and asserts the security
// invariant; it fails if the escaping in the route is reverted to raw
// interpolation.

import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  orFilter: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

// Model only what the route calls on the contacts lookup. Returning [] matches
// makes the route early-return, so the bookings chain is never reached.
vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      if (table === "contacts") {
        return {
          select: () => ({
            or: (filter: string) => {
              mocks.orFilter(filter);
              return { limit: () => Promise.resolve({ data: [], error: null }) };
            },
          }),
        };
      }
      return {};
    },
  }),
}));

import { GET } from "@/app/api/bookings/route";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";

function getReq(contactQuery: string): Request {
  const u = new URL("https://tenant.example.com/api/bookings");
  u.searchParams.set("contact_query", contactQuery);
  return new Request(u, { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID, source: { kind: "http_request", user_id: "u1" } },
  });
});

describe("GET /api/bookings contact_query injection (#558)", () => {
  it("never lets contact_query add OR conditions beyond the 3 intended columns", async () => {
    // The payload tries to graft on an `email.ilike.%@victim.com` term via a comma.
    const res = await GET(getReq("smith,email.ilike.%@victim.com"));
    expect(res.status).toBe(200);

    expect(mocks.orFilter).toHaveBeenCalledOnce();
    const filter = mocks.orFilter.mock.calls[0]![0] as string;

    // Exactly 3 comma-separated conditions — the user's comma must not create a 4th.
    const parts = filter.split(",");
    expect(parts).toHaveLength(3);
    expect(parts[0]!.startsWith("first_name.ilike.")).toBe(true);
    expect(parts[1]!.startsWith("last_name.ilike.")).toBe(true);
    expect(parts[2]!.startsWith("email.ilike.")).toBe(true);
  });

  it("escapes SQL LIKE wildcards so the term can't widen its own match", async () => {
    const res = await GET(getReq("100%"));
    expect(res.status).toBe(200);

    const filter = mocks.orFilter.mock.calls[0]![0] as string;
    // The user's % is backslash-escaped (literal), not left as a live wildcard.
    expect(filter).toContain("100\\%");
    expect(filter).not.toContain("100%");
  });
});
