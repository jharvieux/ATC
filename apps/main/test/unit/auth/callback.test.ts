// §17.1 / §17.2 / §17.3 — OAuth callback (PKCE rewrite, #70).
//
// Contracts pinned here:
//   1. Session establishment: a successful exchange must flush the session
//      cookies (applyAuthCookies) onto the redirect — the prior client never
//      wrote a session, which is the whole bug this rewrite closes.
//   2. Tenant-vs-platform split (#441): a UUID tenant id upserts the users
//      membership row; the "platform" sentinel skips the upsert when
//      PLATFORM_DEFAULT_TENANT_ID is unset, but uses the default tenant when
//      that env var is set — so platform-domain sign-ups land in a real agency.
//   3. Post-login redirect (#437): a SAFE ?next= is honored; unsafe values
//      fall back to "/".
//   4. Microsoft no-email chain (§17.2): azure with no resolvable email lands
//      on /signup/email-prompt with the _ms_session marker, session still set.
//   5. Fail-loud: a DB error on the membership upsert must throw, never a
//      silent redirect-to-success (a logged-in user with no row is broken).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mockExchange = vi.fn();
const mockApplyAuthCookies = vi.fn(<T>(res: T): T => res);
vi.mock("@/lib/auth/ssr-client", () => ({
  createRouteHandlerClient: () => ({
    supabase: { auth: { exchangeCodeForSession: mockExchange } },
    applyAuthCookies: mockApplyAuthCookies,
  }),
}));

const mockRecover = vi.fn();
vi.mock("@/lib/auth/microsoft-email-recovery", () => ({
  recoverMicrosoftEmail: (...args: unknown[]) => mockRecover(...args),
}));

const mockUpsert = vi.fn();
const mockFrom = vi.fn(() => ({ upsert: mockUpsert }));
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({ from: mockFrom }),
}));

import { GET } from "@/app/api/auth/callback/route";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";

const DEFAULT_TENANT_ID = "f5665f08-3ebb-40e0-ad6b-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PLATFORM_DEFAULT_TENANT_ID;
  mockExchange.mockResolvedValue({
    data: {
      session: {
        access_token: "supabase-jwt",
        provider_token: "ms-graph-token",
        user: {
          id: "auth-user-1",
          email: "alice@example.com",
          app_metadata: { provider: "google" },
        },
      },
    },
    error: null,
  });
  mockUpsert.mockResolvedValue({ data: null, error: null });
});

afterEach(() => {
  delete process.env.PLATFORM_DEFAULT_TENANT_ID;
});

function get(
  qs: string,
  headers: Record<string, string> = { "x-resolved-tenant-id": TENANT_ID },
): Promise<Response> {
  return GET(
    new NextRequest(`https://tenant.example.com/api/auth/callback${qs}`, {
      headers,
    }),
  );
}

describe("GET /api/auth/callback", () => {
  it("redirects to /auth/error and never exchanges when code is missing", async () => {
    const res = await get("?error=access_denied&error_description=nope");
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/auth/error");
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it("redirects to /auth/error when the code exchange fails", async () => {
    mockExchange.mockResolvedValue({
      data: { session: null },
      error: { message: "bad code" },
    });
    const res = await get("?code=abc");
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/auth/error");
    expect(loc.searchParams.get("message")).toBe("bad code");
  });

  it("on a tenant domain: upserts the membership row, sets session cookies, lands on /", async () => {
    const res = await get("?code=abc");
    expect(mockExchange).toHaveBeenCalledWith("abc");
    expect(mockFrom).toHaveBeenCalledWith("users");
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0]?.[0]).toEqual({
      auth_user_id: "auth-user-1",
      tenant_id: TENANT_ID,
      email: "alice@example.com",
      status: "active",
    });
    expect(mockApplyAuthCookies).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });

  it("honors a safe ?next= forwarded from initiate (#437)", async () => {
    const res = await get("?code=abc&next=%2Fcrm%2Fbookings");
    expect(new URL(res.headers.get("location")!).pathname).toBe("/crm/bookings");
  });

  it("drops an unsafe ?next= (open redirect) and falls back to /", async () => {
    const res = await get("?code=abc&next=%2F%2Fevil.com");
    const loc = new URL(res.headers.get("location")!);
    expect(loc.host).toBe("tenant.example.com");
    expect(loc.pathname).toBe("/");
  });

  it("on the platform domain with no default tenant configured: does NOT upsert but still sets the session", async () => {
    // PLATFORM_DEFAULT_TENANT_ID is not set (deleted in beforeEach).
    const res = await get("?code=abc", { "x-resolved-tenant-id": "platform" });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockApplyAuthCookies).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });

  it("on the platform domain with PLATFORM_DEFAULT_TENANT_ID set: upserts into that tenant", async () => {
    // Locks the default-tenant assignment: platform-domain sign-ups must land
    // in a real agency row so the user can access chat and other tenant features.
    process.env.PLATFORM_DEFAULT_TENANT_ID = DEFAULT_TENANT_ID;
    const res = await get("?code=abc", { "x-resolved-tenant-id": "platform" });
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0]?.[0]).toEqual({
      auth_user_id: "auth-user-1",
      tenant_id: DEFAULT_TENANT_ID,
      email: "alice@example.com",
      status: "active",
    });
    expect(mockApplyAuthCookies).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });

  it("with no x-resolved-tenant-id header and PLATFORM_DEFAULT_TENANT_ID set: upserts into the default tenant", async () => {
    // Guards the !tenantId branch of effectiveTenantId: a request with no
    // header at all (e.g. a direct hit bypassing middleware) must still land
    // the user in the default tenant when the env var is configured.
    process.env.PLATFORM_DEFAULT_TENANT_ID = DEFAULT_TENANT_ID;
    const res = await get("?code=abc", {});
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0]?.[0]).toMatchObject({
      auth_user_id: "auth-user-1",
      tenant_id: DEFAULT_TENANT_ID,
    });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });

  it("on the platform domain with default tenant: does NOT upsert when email is missing (bounced to email-prompt first)", async () => {
    // The no-email path redirects before the upsert block — the upsert must
    // not run for a user who still needs to supply their email.
    process.env.PLATFORM_DEFAULT_TENANT_ID = DEFAULT_TENANT_ID;
    mockExchange.mockResolvedValue({
      data: {
        session: {
          access_token: "supabase-jwt",
          user: { id: "auth-user-noemail", email: null, app_metadata: { provider: "google" } },
        },
      },
      error: null,
    });
    const res = await get("?code=abc", { "x-resolved-tenant-id": "platform" });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(new URL(res.headers.get("location")!).pathname).toBe("/signup/email-prompt");
  });

  it("Microsoft with no resolvable email: lands on /signup/email-prompt, session still set, NO upsert", async () => {
    mockExchange.mockResolvedValue({
      data: {
        session: {
          access_token: "supabase-jwt",
          provider_token: "ms-graph-token",
          user: {
            id: "auth-user-2",
            email: null,
            app_metadata: { provider: "azure" },
          },
        },
      },
      error: null,
    });
    mockRecover.mockResolvedValue(null);

    const res = await get("?code=abc");
    expect(mockRecover).toHaveBeenCalledWith(null, "ms-graph-token");
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(new URL(res.headers.get("location")!).pathname).toBe(
      "/signup/email-prompt",
    );
    expect(mockApplyAuthCookies).toHaveBeenCalledTimes(1);
  });

  it("Facebook (or any non-azure provider) with null email: same OTP recovery — /signup/email-prompt, NO Graph call, NO upsert", async () => {
    mockExchange.mockResolvedValue({
      data: {
        session: {
          access_token: "supabase-jwt",
          user: {
            id: "auth-user-fb",
            email: null,
            app_metadata: { provider: "facebook" },
          },
        },
      },
      error: null,
    });
    const res = await get("?code=abc");
    expect(mockRecover).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(new URL(res.headers.get("location")!).pathname).toBe(
      "/signup/email-prompt",
    );
    expect(mockApplyAuthCookies).toHaveBeenCalledTimes(1);
  });

  it("Microsoft WITH a recovered email: upserts the row and lands on /", async () => {
    mockExchange.mockResolvedValue({
      data: {
        session: {
          access_token: "supabase-jwt",
          provider_token: "ms-graph-token",
          user: {
            id: "auth-user-3",
            email: null,
            app_metadata: { provider: "azure" },
          },
        },
      },
      error: null,
    });
    mockRecover.mockResolvedValue("recovered@example.com");

    const res = await get("?code=abc");
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0]?.[0]).toMatchObject({
      auth_user_id: "auth-user-3",
      email: "recovered@example.com",
    });
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });

  it("fails loud: a DB error on the membership upsert throws instead of redirecting to success", async () => {
    mockUpsert.mockResolvedValue({
      data: null,
      error: { message: "permission denied", code: "42501" },
    });
    await expect(get("?code=abc")).rejects.toThrow(/auth\.callback\.users\.upsert/);
  });
});
