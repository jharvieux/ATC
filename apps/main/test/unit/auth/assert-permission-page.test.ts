// Unit tests for assertPermissionPage — page-level RBAC gate for server components.
//
// Pins the two denial paths that assertPermissionPage enforces:
//   1. No session / no tenant membership → redirect("/")
//   2. Role exists but RBAC matrix denies the (resource, action) → redirect("/")
//
// And the allow path:
//   3. Authenticated member whose role is permitted → returns role, no redirect
//
// Each test uses vi.resetModules() + dynamic import to get a fresh module
// instance, defeating React.cache memoization that would otherwise bleed
// results between tests.

import { describe, it, expect, vi, beforeEach } from "vitest";

// redirect() throws in Next.js (NEXT_REDIRECT). Simulate so tests can assert.
const mockRedirect = vi.fn(() => {
  throw new Error("NEXT_REDIRECT");
});

// Mock next/navigation at the module level — safe to hoist since we don't
// need per-test variants of redirect().
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

// All other deps are reset per-test via vi.resetModules() + re-import.

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

async function setup({
  isAuthenticated = true,
  userId = "user-123",
  tenantId = "tenant-abc",
  tenantRole = "agent" as string | null,
  permitted = true,
}: {
  isAuthenticated?: boolean;
  userId?: string;
  tenantId?: string | null;
  tenantRole?: string | null;
  permitted?: boolean;
} = {}) {
  vi.doMock("@/lib/auth/get-cached-user", () => ({
    getCachedUser: vi.fn().mockResolvedValue({
      isAuthenticated,
      user: isAuthenticated ? { id: userId } : null,
    }),
  }));

  vi.doMock("next/headers", () => ({
    headers: vi.fn().mockResolvedValue(
      tenantId ? new Headers({ "x-resolved-tenant-id": tenantId }) : new Headers({}),
    ),
  }));

  vi.doMock("@/lib/auth/resolve-post-login", () => ({
    getTenantRole: vi.fn().mockResolvedValue(tenantRole),
  }));

  vi.doMock("@/lib/auth/permission-grants", () => ({
    isPermitted: vi.fn().mockReturnValue(permitted),
  }));

  const mod = await import("@/lib/auth/assert-permission-page");
  const permMod = await import("@/lib/auth/permission-grants");
  return { assertPermissionPage: mod.assertPermissionPage, isPermitted: permMod.isPermitted };
}

describe("assertPermissionPage", () => {
  it("returns the role when caller is permitted", async () => {
    const { assertPermissionPage, isPermitted } = await setup({
      tenantRole: "agent",
      permitted: true,
    });
    const role = await assertPermissionPage({ resource: "bookings", action: "read" });
    expect(role).toBe("agent");
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(isPermitted).toHaveBeenCalledWith("agent", "bookings", "read");
  });

  it("calls redirect('/') when getCachedTenantRole returns null (unauthenticated)", async () => {
    const { assertPermissionPage } = await setup({ isAuthenticated: false });
    await expect(
      assertPermissionPage({ resource: "bookings", action: "read" }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith("/");
  });

  it("calls redirect('/') when tenant header is absent (platform sentinel)", async () => {
    const { assertPermissionPage } = await setup({ tenantId: null });
    await expect(
      assertPermissionPage({ resource: "contacts", action: "list" }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith("/");
  });

  it("calls redirect('/') when RBAC matrix denies the (resource, action) pair", async () => {
    const { assertPermissionPage, isPermitted } = await setup({
      tenantRole: "viewer",
      permitted: false,
    });
    await expect(
      assertPermissionPage({ resource: "quotes", action: "read" }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith("/");
    expect(isPermitted).toHaveBeenCalledWith("viewer", "quotes", "read");
  });

  it("calls redirect('/') when getTenantRole throws — fail-closed on DB error", async () => {
    vi.doMock("@/lib/auth/get-cached-user", () => ({
      getCachedUser: vi.fn().mockResolvedValue({ isAuthenticated: true, user: { id: "u1" } }),
    }));
    vi.doMock("next/headers", () => ({
      headers: vi.fn().mockResolvedValue(new Headers({ "x-resolved-tenant-id": "t1" })),
    }));
    vi.doMock("@/lib/auth/resolve-post-login", () => ({
      getTenantRole: vi.fn().mockRejectedValue(new Error("db_connection_failed")),
    }));
    vi.doMock("@/lib/auth/permission-grants", () => ({
      isPermitted: vi.fn().mockReturnValue(true),
    }));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { assertPermissionPage } = await import("@/lib/auth/assert-permission-page");
    await expect(
      assertPermissionPage({ resource: "contacts", action: "list" }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith("/");
    expect(consoleSpy).toHaveBeenCalledWith(
      "[assert-permission-page] getTenantRole failed:",
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });
});
