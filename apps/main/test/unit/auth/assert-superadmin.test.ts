// §26 — assertSuperadmin gate. Builds on assertPlatformAdmin: the caller must
// be a platform admin AND have role 'superadmin'. This is the first per-role
// check on the platform side (platform-admin management).

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), lookup: vi.fn() }));

vi.mock("@/lib/auth/ssr-client", () => ({
  createRequestScopedClient: () => ({ auth: { getUser: mocks.getUser } }),
}));
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.lookup }) }) }),
  }),
}));

import { assertSuperadmin } from "@/lib/auth/assert-platform-admin";

function req(): Request {
  return new Request("https://admin.internal/", { headers: { cookie: "sb=1" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
});

describe("assertSuperadmin", () => {
  it("returns the context for a superadmin", async () => {
    mocks.lookup.mockResolvedValue({ data: { auth_user_id: "u1", role: "superadmin" }, error: null });
    const ctx = await assertSuperadmin(req());
    expect(ctx.role).toBe("superadmin");
    expect(ctx.admin_user_id).toBe("u1");
  });

  it("throws 403 not_a_superadmin for a non-superadmin platform admin", async () => {
    mocks.lookup.mockResolvedValue({ data: { auth_user_id: "u1", role: "reviewer" }, error: null });
    await expect(assertSuperadmin(req())).rejects.toMatchObject({ status: 403, code: "not_a_superadmin" });
  });

  it("throws 403 not_a_platform_admin when the user isn't an admin at all", async () => {
    mocks.lookup.mockResolvedValue({ data: null, error: null });
    await expect(assertSuperadmin(req())).rejects.toMatchObject({ status: 403, code: "not_a_platform_admin" });
  });

  it("throws 401 when the session is invalid", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: "bad" } });
    await expect(assertSuperadmin(req())).rejects.toMatchObject({ status: 401 });
  });
});
