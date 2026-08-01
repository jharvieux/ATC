// §26 admin session gate — unit tests for the assertPlatformAdmin helper.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAuthGetUser = vi.fn();
const mockFromMaybeSingle = vi.fn();

vi.mock("@/lib/auth/ssr-client", () => ({
  createRequestScopedClient: () => ({ auth: { getUser: mockAuthGetUser } }),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: mockFromMaybeSingle }),
      }),
    }),
  }),
}));

import {
  assertPlatformAdmin,
  assertPlatformRole,
  assertPlatformAdminArea,
  PlatformAdminError,
} from "@/lib/auth/assert-platform-admin";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = {
    ...ORIGINAL_ENV,
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    MAIN_APP_ADMIN_API_KEY: "service-secret-key",
  };
});

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://test/api/admin/x", { headers });
}

describe("assertPlatformAdmin", () => {
  it("accepts the service-to-service Bearer key without touching the cookie session", async () => {
    const ctx = await assertPlatformAdmin(req({ Authorization: "Bearer service-secret-key" }));
    expect(ctx).toEqual({ admin_user_id: "service:bearer", role: "service", via: "bearer" });
    expect(mockAuthGetUser).not.toHaveBeenCalled();
    expect(mockFromMaybeSingle).not.toHaveBeenCalled();
  });

  // #2002 / D-091 #28 — rotation-set acceptance on the seam's authoritative gate.
  it("accepts MAIN_APP_ADMIN_API_KEY_CURRENT and _PREVIOUS during rotation overlap", async () => {
    delete process.env.MAIN_APP_ADMIN_API_KEY;
    process.env.MAIN_APP_ADMIN_API_KEY_CURRENT = "rotated-current";
    process.env.MAIN_APP_ADMIN_API_KEY_PREVIOUS = "old-previous";
    const current = await assertPlatformAdmin(req({ Authorization: "Bearer rotated-current" }));
    expect(current.role).toBe("service");
    const previous = await assertPlatformAdmin(req({ Authorization: "Bearer old-previous" }));
    expect(previous.role).toBe("service");
  });

  it("falls through to the cookie session when no Authorization header is present (§17.x posture)", async () => {
    mockAuthGetUser.mockResolvedValue({ data: { user: { id: "uuid-1" } }, error: null });
    mockFromMaybeSingle.mockResolvedValue({
      data: { auth_user_id: "uuid-1", role: "superadmin" },
      error: null,
    });
    const ctx = await assertPlatformAdmin(req());
    expect(ctx).toEqual({ admin_user_id: "uuid-1", role: "superadmin", via: "session" });
    expect(mockAuthGetUser).toHaveBeenCalledTimes(1);
  });

  it("rejects when neither a valid service Bearer nor a verifiable cookie session is present (401)", async () => {
    mockAuthGetUser.mockResolvedValue({ data: null, error: { message: "no session" } });
    await expect(
      assertPlatformAdmin(req({ Authorization: "Bearer not-the-service-key" })),
    ).rejects.toMatchObject({ status: 401, code: "invalid_session" });
  });

  it("rejects when no credential at all is present (401)", async () => {
    mockAuthGetUser.mockResolvedValue({ data: null, error: { message: "no session" } });
    await expect(assertPlatformAdmin(req())).rejects.toMatchObject({
      status: 401,
      code: "invalid_session",
    });
  });

  it("rejects a verified Supabase session that is NOT in platform_admins with 403", async () => {
    mockAuthGetUser.mockResolvedValue({ data: { user: { id: "uuid-2" } }, error: null });
    mockFromMaybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(assertPlatformAdmin(req())).rejects.toMatchObject({
      status: 403,
      code: "not_a_platform_admin",
    });
  });

  it("surfaces a platform_admins lookup error as 500", async () => {
    mockAuthGetUser.mockResolvedValue({ data: { user: { id: "uuid-3" } }, error: null });
    mockFromMaybeSingle.mockResolvedValue({ data: null, error: { message: "db down" } });
    await expect(assertPlatformAdmin(req())).rejects.toMatchObject({
      status: 500,
      code: "platform_admins_lookup_failed",
    });
  });

  it("PlatformAdminError.toResponse() produces a JSON Response with the right status", async () => {
    const err = new PlatformAdminError(403, "not_a_platform_admin", "test");
    const res = err.toResponse();
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_a_platform_admin");
  });
});

describe("assertPlatformRole", () => {
  it("passes when the caller's role is in the allowed set", async () => {
    mockAuthGetUser.mockResolvedValue({ data: { user: { id: "uuid-r" } }, error: null });
    mockFromMaybeSingle.mockResolvedValue({
      data: { auth_user_id: "uuid-r", role: "reviewer" },
      error: null,
    });
    const ctx = await assertPlatformRole(req(), ["superadmin", "reviewer"]);
    expect(ctx.role).toBe("reviewer");
  });

  it("rejects with 403 when the caller's role is not in the allowed set", async () => {
    mockAuthGetUser.mockResolvedValue({ data: { user: { id: "uuid-s" } }, error: null });
    mockFromMaybeSingle.mockResolvedValue({
      data: { auth_user_id: "uuid-s", role: "support" },
      error: null,
    });
    await expect(
      assertPlatformRole(req(), ["superadmin", "reviewer"]),
    ).rejects.toMatchObject({ status: 403, code: "insufficient_role" });
  });

  it("allows the service bearer when 'service' is in the allowed set", async () => {
    const ctx = await assertPlatformRole(req({ Authorization: "Bearer service-secret-key" }), [
      "superadmin",
      "reviewer",
      "service",
    ]);
    expect(ctx.role).toBe("service");
  });

  it("rejects the service bearer when 'service' is NOT in the allowed set", async () => {
    await expect(
      assertPlatformRole(req({ Authorization: "Bearer service-secret-key" }), ["superadmin"]),
    ).rejects.toMatchObject({ status: 403, code: "insufficient_role" });
  });

  it("propagates assertPlatformAdmin failures (e.g. invalid session) before role check", async () => {
    mockAuthGetUser.mockResolvedValue({ data: null, error: { message: "no session" } });
    await expect(
      assertPlatformRole(req(), ["superadmin", "reviewer"]),
    ).rejects.toMatchObject({ status: 401, code: "invalid_session" });
  });
});

// assertPlatformAdminArea — area-gate narrowings from #1003
describe("assertPlatformAdminArea", () => {
  function sessionReq(role: string) {
    mockAuthGetUser.mockResolvedValue({ data: { user: { id: "uid" } }, error: null });
    mockFromMaybeSingle.mockResolvedValue({ data: { auth_user_id: "uid", role }, error: null });
    return req();
  }

  it("allows superadmin access to every area", async () => {
    const ctx = await assertPlatformAdminArea(sessionReq("superadmin"), "abuse");
    expect(ctx.role).toBe("superadmin");
  });

  it("rejects reviewer from abuse (superadmin-only per #1003)", async () => {
    await expect(
      assertPlatformAdminArea(sessionReq("reviewer"), "abuse"),
    ).rejects.toMatchObject({ status: 403, code: "insufficient_role" });
  });

  it("rejects reviewer from tenants (superadmin-only per #1003)", async () => {
    await expect(
      assertPlatformAdminArea(sessionReq("reviewer"), "tenants"),
    ).rejects.toMatchObject({ status: 403, code: "insufficient_role" });
  });

  it("rejects reviewer from personas (superadmin-only per #1003)", async () => {
    await expect(
      assertPlatformAdminArea(sessionReq("reviewer"), "personas"),
    ).rejects.toMatchObject({ status: 403, code: "insufficient_role" });
  });

  it("rejects support from resource_util (finance-only per #1003)", async () => {
    await expect(
      assertPlatformAdminArea(sessionReq("support"), "resource_util"),
    ).rejects.toMatchObject({ status: 403, code: "insufficient_role" });
  });

  it("allows reviewer access to rag (which reviewer retains)", async () => {
    const ctx = await assertPlatformAdminArea(sessionReq("reviewer"), "rag");
    expect(ctx.role).toBe("reviewer");
  });

  it("allows finance access to reconciliation", async () => {
    const ctx = await assertPlatformAdminArea(sessionReq("finance"), "reconciliation");
    expect(ctx.role).toBe("finance");
  });

  it("allows service bearer access to rag", async () => {
    const ctx = await assertPlatformAdminArea(
      req({ Authorization: "Bearer service-secret-key" }),
      "rag",
    );
    expect(ctx.role).toBe("service");
  });

  it("rejects service bearer from areas without 'service' in the grants (e.g. chunks)", async () => {
    await expect(
      assertPlatformAdminArea(req({ Authorization: "Bearer service-secret-key" }), "chunks"),
    ).rejects.toMatchObject({ status: 403, code: "insufficient_role" });
  });
});
