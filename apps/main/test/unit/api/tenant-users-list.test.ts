// §26.2 — Tests for GET /api/tenant/users.
//
// Pins that the list returns the caller's own role (caller_role). The
// /settings/users page derives "can this user edit roles?" ENTIRELY from this
// field, so a regression that dropped or mis-set it would silently expose the
// role dropdown to non-owners (or hide it from owners) with no other signal.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  order: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ order: mocks.order }) }),
    }),
  }),
}));

import { GET } from "@/app/api/tenant/users/route";

function req(): Request {
  return new Request("http://test/api/tenant/users");
}

function userWithRole(role: string) {
  return {
    ctx: { tenant_id: "t-1", source: { kind: "http_request", user_id: "u-self" } },
    user: { id: "u-self", auth_user_id: "auth-self", tenant_id: "t-1", status: "active", role },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue(userWithRole("agent"));
  mocks.order.mockResolvedValue({ data: [], error: null });
});

describe("GET /api/tenant/users", () => {
  it("returns members and the caller's role (drives the page's edit gating)", async () => {
    mocks.order.mockResolvedValue({
      data: [
        { id: "u1", auth_user_id: "a1", email: "a@b.com", display_name: null, first_name: null, last_name: null, role: "viewer", status: "active", last_signed_in_at: null, created_at: "2026-01-01" },
      ],
      error: null,
    });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: unknown[]; caller_role: string };
    expect(body.caller_role).toBe("agent");
    expect(body.members).toHaveLength(1);
  });

  it("passes through tenant_owner so the page enables editing", async () => {
    mocks.assertPermission.mockResolvedValue(userWithRole("tenant_owner"));
    const res = await GET(req());
    expect(((await res.json()) as { caller_role: string }).caller_role).toBe("tenant_owner");
  });

  it("returns 500 on a DB error", async () => {
    mocks.order.mockResolvedValue({ data: null, error: { message: "boom" } });
    const res = await GET(req());
    expect(res.status).toBe(500);
  });
});
