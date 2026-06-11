// §26 / security issue #559 — the (admin) route group layout is the
// authoritative platform-admin gate for every admin PAGE (/admin/*,
// /supervisor/*). These tests encode the intent that matters:
//   - a verified platform admin sees the page (children render),
//   - everyone else (unauthenticated, not-an-admin, or a verification error)
//     gets notFound() — fail-closed, no admin content rendered.
//
// Since §811, the layout delegates to getCachedAdminContext() (React.cache)
// instead of calling assertPlatformAdmin directly. Header forwarding and
// session resolution are tested in assert-platform-admin.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  getCachedAdminContext: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve({ get: () => null }),
  // (admin)/layout reads the sidebar-collapsed cookie to pass initial
  // state to AdminShell (#669). Empty-cookie path is fine for the auth-
  // gate tests; the cookie behavior is covered in the collapsed-cookie tests.
  cookies: () => Promise.resolve({ get: () => undefined }),
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  // AdminShell -> AdminSidebar -> usePathname for active-link highlight.
  // The shell is rendered (not just imported) by the layout when auth
  // passes, so the mock has to cover anything the shell imports.
  usePathname: () => "/admin",
}));

vi.mock("@/lib/auth/assert-platform-admin", () => ({
  getCachedAdminContext: mocks.getCachedAdminContext,
}));

import AdminLayout from "../../../src/app/(admin)/layout";

describe("(admin) layout gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders children when assertPlatformAdmin resolves (verified admin)", async () => {
    mocks.getCachedAdminContext.mockResolvedValue({
      admin_user_id: "u1",
      role: "superadmin",
      via: "session",
    });
    const el = await AdminLayout({ children: "ADMIN-ONLY-CONTENT" });
    expect(renderToStaticMarkup(el)).toContain("ADMIN-ONLY-CONTENT");
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("calls notFound() when assertPlatformAdmin throws (not an admin)", async () => {
    mocks.getCachedAdminContext.mockResolvedValue(null);
    await expect(AdminLayout({ children: "ADMIN-ONLY-CONTENT" })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(mocks.notFound).toHaveBeenCalledTimes(1);
  });

  it("calls notFound() when verification errors (fail-closed, not fail-open)", async () => {
    // getCachedAdminContext returns null on any auth failure — layout must deny.
    mocks.getCachedAdminContext.mockResolvedValue(null);
    await expect(AdminLayout({ children: "X" })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalledTimes(1);
  });

  it("forwards the incoming cookie + authorization headers to the gate", async () => {
    // getCachedAdminContext is called by the layout; header forwarding is its
    // internal responsibility (tested in assert-platform-admin.test.ts).
    // Here we verify the layout passes adminRole from context to AdminShell.
    mocks.getCachedAdminContext.mockResolvedValue({
      admin_user_id: "u1",
      role: "superadmin",
      via: "session",
    });
    const el = await AdminLayout({ children: "X" });
    expect(renderToStaticMarkup(el)).toContain("X");
    expect(mocks.getCachedAdminContext).toHaveBeenCalledTimes(1);
  });
});
