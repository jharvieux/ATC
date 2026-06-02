// §26 / security issue #559 — the (admin) route group layout is the
// authoritative platform-admin gate for every admin PAGE (/admin/*,
// /supervisor/*). These tests encode the intent that matters:
//   - a verified platform admin sees the page (children render),
//   - everyone else (unauthenticated, not-an-admin, or a verification error)
//     gets notFound() — fail-closed, no admin content rendered,
//   - the incoming session credentials actually reach assertPlatformAdmin
//     (a regression that forwarded the wrong headers would silently log every
//     admin out, or worse, gate on nothing).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  assertPlatformAdmin: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  headersGet: vi.fn((_name: string): string | null => null),
}));

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve({ get: mocks.headersGet }),
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
}));

vi.mock("@/lib/auth/assert-platform-admin", () => ({
  assertPlatformAdmin: mocks.assertPlatformAdmin,
}));

import AdminLayout from "../../../src/app/(admin)/layout";

describe("(admin) layout gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headersGet.mockReturnValue(null);
  });

  it("renders children when assertPlatformAdmin resolves (verified admin)", async () => {
    mocks.assertPlatformAdmin.mockResolvedValue({
      admin_user_id: "u1",
      role: "owner",
      via: "session",
    });
    const el = await AdminLayout({ children: "ADMIN-ONLY-CONTENT" });
    expect(renderToStaticMarkup(el)).toContain("ADMIN-ONLY-CONTENT");
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("calls notFound() when assertPlatformAdmin throws (not an admin)", async () => {
    mocks.assertPlatformAdmin.mockRejectedValue(new Error("not_a_platform_admin"));
    await expect(AdminLayout({ children: "ADMIN-ONLY-CONTENT" })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(mocks.notFound).toHaveBeenCalledTimes(1);
  });

  it("calls notFound() when verification errors (fail-closed, not fail-open)", async () => {
    // A 500-class failure (e.g. DB lookup error) must still deny, never render.
    mocks.assertPlatformAdmin.mockRejectedValue(new Error("platform_admins_lookup_failed"));
    await expect(AdminLayout({ children: "X" })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalledTimes(1);
  });

  it("forwards the incoming cookie + authorization headers to the gate", async () => {
    mocks.assertPlatformAdmin.mockResolvedValue({
      admin_user_id: "u1",
      role: "owner",
      via: "session",
    });
    mocks.headersGet.mockImplementation((name: string) =>
      name === "cookie"
        ? "sb-abcdef-auth-token=blob"
        : name === "authorization"
          ? "Bearer svc-key"
          : null,
    );
    await AdminLayout({ children: "X" });
    const passedReq = mocks.assertPlatformAdmin.mock.calls[0]?.[0] as Request;
    expect(passedReq.headers.get("cookie")).toBe("sb-abcdef-auth-token=blob");
    expect(passedReq.headers.get("authorization")).toBe("Bearer svc-key");
  });
});
