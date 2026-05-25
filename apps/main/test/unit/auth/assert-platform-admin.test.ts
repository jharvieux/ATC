// §26 admin session gate — unit tests for the assertPlatformAdmin helper.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAuthGetUser = vi.fn();
const mockFromMaybeSingle = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser: mockAuthGetUser } }),
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

import { assertPlatformAdmin, PlatformAdminError } from "@/lib/auth/assert-platform-admin";

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

function req(headers: Record<string, string>): Request {
  return new Request("http://test/api/admin/x", { headers });
}

describe("assertPlatformAdmin", () => {
  it("throws 401 when Authorization header is missing", async () => {
    await expect(assertPlatformAdmin(req({}))).rejects.toMatchObject({
      status: 401,
      code: "missing_bearer",
    });
  });

  it("throws 401 when Bearer token is empty", async () => {
    await expect(
      assertPlatformAdmin(req({ Authorization: "Bearer " })),
    ).rejects.toMatchObject({ status: 401, code: "missing_bearer" });
  });

  it("accepts the service-to-service Bearer key as a valid admin", async () => {
    const ctx = await assertPlatformAdmin(req({ Authorization: "Bearer service-secret-key" }));
    expect(ctx).toEqual({ admin_user_id: "service:bearer", role: "service", via: "bearer" });
    // Should NOT have consulted Supabase or platform_admins.
    expect(mockAuthGetUser).not.toHaveBeenCalled();
    expect(mockFromMaybeSingle).not.toHaveBeenCalled();
  });

  it("rejects an opaque non-JWT, non-matching Bearer with 401", async () => {
    mockAuthGetUser.mockResolvedValue({ data: null, error: { message: "invalid jwt" } });
    await expect(
      assertPlatformAdmin(req({ Authorization: "Bearer not-the-service-key" })),
    ).rejects.toMatchObject({ status: 401, code: "invalid_session" });
  });

  it("accepts a verified Supabase session that exists in platform_admins", async () => {
    mockAuthGetUser.mockResolvedValue({ data: { user: { id: "uuid-1" } }, error: null });
    mockFromMaybeSingle.mockResolvedValue({
      data: { auth_user_id: "uuid-1", role: "superadmin" },
      error: null,
    });
    const ctx = await assertPlatformAdmin(req({ Authorization: "Bearer eyJ.fake.jwt" }));
    expect(ctx).toEqual({ admin_user_id: "uuid-1", role: "superadmin", via: "session" });
  });

  it("rejects a verified Supabase session that is NOT in platform_admins with 403", async () => {
    mockAuthGetUser.mockResolvedValue({ data: { user: { id: "uuid-2" } }, error: null });
    mockFromMaybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(
      assertPlatformAdmin(req({ Authorization: "Bearer eyJ.fake.jwt" })),
    ).rejects.toMatchObject({ status: 403, code: "not_a_platform_admin" });
  });

  it("surfaces a platform_admins lookup error as 500", async () => {
    mockAuthGetUser.mockResolvedValue({ data: { user: { id: "uuid-3" } }, error: null });
    mockFromMaybeSingle.mockResolvedValue({ data: null, error: { message: "db down" } });
    await expect(
      assertPlatformAdmin(req({ Authorization: "Bearer eyJ.fake.jwt" })),
    ).rejects.toMatchObject({ status: 500, code: "platform_admins_lookup_failed" });
  });

  it("PlatformAdminError.toResponse() produces a JSON Response with the right status", async () => {
    const err = new PlatformAdminError(403, "not_a_platform_admin", "test");
    const res = err.toResponse();
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_a_platform_admin");
  });
});
