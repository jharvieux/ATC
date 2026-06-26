// Unit tests for assertPermissionPage — the page-safe auth gate for
// Next.js App Router server components.
//
// Why these tests matter: without a gate, an unauthenticated user or a
// user with no active tenant membership can navigate directly to a staff
// page, see the shell, and receive a 403 from the backing API. These tests
// verify the gate fires redirect() before the page renders in all failure
// modes, and that the happy path returns the correct role (issue #1406).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UserRole } from "@/lib/auth/permission-grants";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";

// --- mocks ----------------------------------------------------------------

const mockGetCachedUser = vi.fn();
const mockGetTenantRole = vi.fn();
const mockRedirect = vi.fn();

vi.mock("@/lib/auth/get-cached-user", () => ({
  getCachedUser: () => mockGetCachedUser(),
}));

vi.mock("@/lib/auth/resolve-post-login", () => ({
  getTenantRole: (...args: unknown[]) => mockGetTenantRole(...args),
}));

// next/headers — return a minimal Headers-like map
const mockHeadersStore = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => mockHeadersStore.get(name) ?? null,
  }),
}));

// next/navigation — capture redirect calls so tests can assert on them
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    mockRedirect(url);
    // In Next.js redirect() throws NEXT_REDIRECT internally; simulate that
    // so control flow in the helper stops after redirect().
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT" });
  },
}));

// react.cache — passthrough (not a real server environment in vitest)
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

// Import AFTER mocks are wired
import { assertPermissionPage, getCachedTenantRole } from "@/lib/auth/assert-permission-page";

const TENANT_ID = "tenant-uuid-abc";
const AUTH_USER_ID = "auth-user-uuid-123";

beforeEach(() => {
  vi.clearAllMocks();
  mockHeadersStore.clear();
  mockHeadersStore.set(RESOLVED_TENANT_ID_HEADER, TENANT_ID);
});

// ---------------------------------------------------------------------------

describe("getCachedTenantRole", () => {
  it("returns null when there is no valid session", async () => {
    mockGetCachedUser.mockResolvedValue({ isAuthenticated: false, user: null });
    const role = await getCachedTenantRole();
    expect(role).toBeNull();
    expect(mockGetTenantRole).not.toHaveBeenCalled();
  });

  it("returns null when the resolved-tenant-id header is absent", async () => {
    mockHeadersStore.delete(RESOLVED_TENANT_ID_HEADER);
    mockGetCachedUser.mockResolvedValue({
      isAuthenticated: true,
      user: { id: AUTH_USER_ID },
    });
    const role = await getCachedTenantRole();
    expect(role).toBeNull();
    expect(mockGetTenantRole).not.toHaveBeenCalled();
  });

  it("returns null when the resolved-tenant-id is the platform sentinel", async () => {
    mockHeadersStore.set(RESOLVED_TENANT_ID_HEADER, "platform");
    mockGetCachedUser.mockResolvedValue({
      isAuthenticated: true,
      user: { id: AUTH_USER_ID },
    });
    const role = await getCachedTenantRole();
    expect(role).toBeNull();
    expect(mockGetTenantRole).not.toHaveBeenCalled();
  });

  it("returns null when the user has no active membership in the resolved tenant", async () => {
    mockGetCachedUser.mockResolvedValue({
      isAuthenticated: true,
      user: { id: AUTH_USER_ID },
    });
    mockGetTenantRole.mockResolvedValue(null);
    const role = await getCachedTenantRole();
    expect(role).toBeNull();
  });

  it("returns null and logs error when getTenantRole throws — fail-closed on DB error", async () => {
    // WHY: a DB failure must not silently permit access — returning null causes
    // assertPermissionPage to redirect rather than accidentally granting the role.
    mockGetCachedUser.mockResolvedValue({
      isAuthenticated: true,
      user: { id: AUTH_USER_ID },
    });
    mockGetTenantRole.mockRejectedValue(new Error("db_connection_failed"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const role = await getCachedTenantRole();
    expect(role).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      "[assert-permission-page] getTenantRole failed:",
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it("returns the role when the user has an active staff membership", async () => {
    mockGetCachedUser.mockResolvedValue({
      isAuthenticated: true,
      user: { id: AUTH_USER_ID },
    });
    mockGetTenantRole.mockResolvedValue("agent" satisfies UserRole);
    const role = await getCachedTenantRole();
    expect(role).toBe("agent");
    expect(mockGetTenantRole).toHaveBeenCalledWith(AUTH_USER_ID, TENANT_ID);
  });
});

// ---------------------------------------------------------------------------

describe("assertPermissionPage", () => {
  it("redirects to '/' when there is no valid session — prevents unauthenticated shell render", async () => {
    // Primary regression guard for #1406: an unauthenticated visitor must
    // never see the page shell followed by a 403 from the backing API.
    mockGetCachedUser.mockResolvedValue({ isAuthenticated: false, user: null });

    await expect(
      assertPermissionPage({ resource: "groups", action: "list" }),
    ).rejects.toMatchObject({ message: "NEXT_REDIRECT" });

    expect(mockRedirect).toHaveBeenCalledWith("/");
  });

  it("redirects to '/' when the user has no active membership in the resolved tenant", async () => {
    mockGetCachedUser.mockResolvedValue({
      isAuthenticated: true,
      user: { id: AUTH_USER_ID },
    });
    mockGetTenantRole.mockResolvedValue(null);

    await expect(
      assertPermissionPage({ resource: "groups", action: "list" }),
    ).rejects.toMatchObject({ message: "NEXT_REDIRECT" });

    expect(mockRedirect).toHaveBeenCalledWith("/");
  });

  it("redirects to '/' when the user's role lacks the requested grant", async () => {
    // Verifies isPermitted is wired — a role that lacks (resource, action) is
    // treated the same as no membership.
    mockGetCachedUser.mockResolvedValue({
      isAuthenticated: true,
      user: { id: AUTH_USER_ID },
    });
    mockGetTenantRole.mockResolvedValue("viewer" satisfies UserRole);

    await expect(
      assertPermissionPage({ resource: "quotes", action: "read" }),
    ).rejects.toMatchObject({ message: "NEXT_REDIRECT" });

    expect(mockRedirect).toHaveBeenCalledWith("/");
  });

  it("returns the role for an agent with the requested grant", async () => {
    mockGetCachedUser.mockResolvedValue({
      isAuthenticated: true,
      user: { id: AUTH_USER_ID },
    });
    mockGetTenantRole.mockResolvedValue("agent" satisfies UserRole);

    const role = await assertPermissionPage({ resource: "contacts", action: "list" });

    expect(role).toBe("agent");
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("returns the role for a tenant_owner with the requested grant", async () => {
    mockGetCachedUser.mockResolvedValue({
      isAuthenticated: true,
      user: { id: AUTH_USER_ID },
    });
    mockGetTenantRole.mockResolvedValue("tenant_owner" satisfies UserRole);

    const role = await assertPermissionPage({ resource: "rag_submissions", action: "review" });

    expect(role).toBe("tenant_owner");
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
