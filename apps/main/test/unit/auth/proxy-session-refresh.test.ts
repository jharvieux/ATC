// §17.x — proxy.ts session-refresh integration (#71).
//
// With cookie-based PKCE sessions the SERVER refreshes — the browser no longer
// holds tokens. Supabase rotates the refresh token on every use, so if proxy.ts
// either fails to trigger a refresh OR fails to write the rotated cookies onto
// the response, the user's session dies the first time the 1h access token
// expires (browser still holds the old refresh token; next refresh attempt
// rejects). These tests pin both halves of that contract.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({
  getTenantBySlug: vi.fn(),
  getTenantByCustomDomain: vi.fn(),
  getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
  applyRefreshedSession: vi.fn(<T>(res: T): T => res),
}));

vi.mock("@/lib/tenancy/resolve-tenant", () => ({
  getTenantBySlug: mocks.getTenantBySlug,
  getTenantByCustomDomain: mocks.getTenantByCustomDomain,
}));

// Keep the real isInvalidSessionError + clearAuthCookies (the self-heal logic
// under test); only the client factory is stubbed so we can drive getUser().
vi.mock("@/lib/auth/ssr-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/ssr-client")>()),
  createMiddlewareClient: () => ({
    supabase: { auth: { getUser: mocks.getUser } },
    applyRefreshedSession: mocks.applyRefreshedSession,
  }),
}));

import { proxy } from "@/proxy";

const ORIG_ENV = { ...process.env };

function req(host: string, pathname = "/", headers: Record<string, string> = {}): NextRequest {
  const h = new Headers(headers);
  h.set("host", host);
  return new NextRequest(`http://${host}${pathname}`, { headers: h });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
  mocks.applyRefreshedSession.mockImplementation(<T>(res: T): T => res);
  process.env.PLATFORM_PRIMARY_DOMAIN = "ai-travelconcierge.com";
  process.env.PLATFORM_DOMAIN_REGEX = "^atc-([a-z0-9-]+)\\.ai-travelconcierge\\.com$";
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v !== undefined) process.env[k] = v;
  }
});

describe("proxy() session refresh", () => {
  it("triggers getUser on the platform domain and applies refreshed cookies to the returned response", async () => {
    const res = await proxy(req("ai-travelconcierge.com"));
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    expect(mocks.applyRefreshedSession).toHaveBeenCalledTimes(1);
    expect(mocks.applyRefreshedSession.mock.calls[0]?.[0]).toBe(res);
  });

  it("triggers getUser on a resolved tenant subdomain and applies refreshed cookies to the returned response", async () => {
    mocks.getTenantBySlug.mockResolvedValue({
      id: "tenant-1",
      tenant_type: "sub_pro",
      subscription_status: "active",
      non_paying_since: null,
      status: "active",
    });
    const res = await proxy(req("atc-acme.ai-travelconcierge.com"));
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    expect(mocks.applyRefreshedSession).toHaveBeenCalledTimes(1);
    expect(mocks.applyRefreshedSession.mock.calls[0]?.[0]).toBe(res);
  });

  it("applies refreshed cookies even on the notFound fallthrough (a transient DB blip on tenant lookup must not strand sessions)", async () => {
    mocks.getTenantByCustomDomain.mockRejectedValue(new Error("pg connection refused"));
    const res = await proxy(req("unknown-domain.com"));
    expect(res.status).toBe(404);
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    expect(mocks.applyRefreshedSession).toHaveBeenCalledTimes(1);
    expect(mocks.applyRefreshedSession.mock.calls[0]?.[0]).toBe(res);
  });

  it("propagates the rotated Set-Cookie a refresh writes onto the final response (session would die otherwise)", async () => {
    mocks.applyRefreshedSession.mockImplementation((res: unknown) => {
      (res as NextResponse).cookies.set({
        name: "sb-x-auth-token",
        value: "rotated",
        path: "/",
        httpOnly: true,
        sameSite: "lax",
      });
      return res;
    });
    const res = await proxy(req("ai-travelconcierge.com"));
    expect(res.headers.get("set-cookie")).toContain("sb-x-auth-token=rotated");
  });

  it("skips the refresh on the admin API gate denial (no Bearer present) — no getUser call, no cookie work", async () => {
    process.env.MAIN_APP_ADMIN_API_KEY = "svc-key";
    const res = await proxy(req("ai-travelconcierge.com", "/api/admin/anything"));
    expect(res.status).toBe(403);
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.applyRefreshedSession).not.toHaveBeenCalled();
  });

  // Regression test for PKCE "code verifier not found in storage":
  // auth-js _removeSession() deletes code_verifier BEFORE firing SIGNED_OUT,
  // so applyServerStorage includes the code_verifier deletion in its setAll
  // call → middleware setAll zeroes the cookie in req.headers → callback
  // reads empty value → combineChunks returns null → error. Fix: skip
  // getUser() for /api/auth/* so stale-session cleanup never runs.
  it("skips getUser on /api/auth/* routes to protect the PKCE code_verifier cookie", async () => {
    const authPaths = [
      "/api/auth/callback",
      "/api/auth/oauth-initiate",
      "/api/auth/signout",
      "/api/auth/me",
    ];
    for (const p of authPaths) {
      vi.clearAllMocks();
      mocks.applyRefreshedSession.mockImplementation(<T>(res: T): T => res);
      const res = await proxy(req("ai-travelconcierge.com", p));
      expect(mocks.getUser, `getUser should not be called for ${p}`).not.toHaveBeenCalled();
      expect(mocks.applyRefreshedSession).toHaveBeenCalledTimes(1);
      expect(mocks.applyRefreshedSession.mock.calls[0]?.[0]).toBe(res);
    }
  });

  it("skips the refresh on the test-bypass short-circuit (no session involved)", async () => {
    (process.env as Record<string, string>).NODE_ENV = "development";
    process.env.VERCEL_ENV = "development";
    process.env.TEST_AUTH_BYPASS_TOKEN = "bypass-token";
    process.env.TEST_AUTH_BYPASS_TENANT_ID = "tenant-bypass";
    await proxy(
      req("atc-acme.ai-travelconcierge.com", "/", { authorization: "Bearer bypass-token" }),
    );
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.applyRefreshedSession).not.toHaveBeenCalled();
  });
});

// §17.x self-heal (#1361) — a present-but-invalid session cookie must be purged
// and the user re-authenticated, instead of being replayed (and wedging
// fail-closed gates at a 404) on every subsequent request.
describe("proxy() invalid-session self-heal", () => {
  const COOKIE = "sb-abc-auth-token=dead-token";
  function invalidSession() {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError("Invalid Refresh Token: Already Used", 400, "refresh_token_already_used"),
    });
  }

  it("clears the dead cookie and redirects to /auth/reauth on a gated path", async () => {
    invalidSession();
    const res = await proxy(req("ai-travelconcierge.com", "/admin", { cookie: COOKIE }));

    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/auth/reauth");
    expect(loc.searchParams.get("return")).toBe("/admin");

    const cleared = res.cookies.get("sb-abc-auth-token");
    expect(cleared?.value).toBe("");
    expect(cleared?.maxAge).toBe(0);
    // Deleted on the same shared scope it was set with, or the browser keeps it.
    expect(cleared?.domain).toBe(".ai-travelconcierge.com");

    // We are clearing, not refreshing — the rotate-and-flush path must not run.
    expect(mocks.applyRefreshedSession).not.toHaveBeenCalled();
  });

  it("redirects on a public path too (redirect-everywhere), preserving the return target", async () => {
    invalidSession();
    const res = await proxy(req("ai-travelconcierge.com", "/", { cookie: COOKIE }));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/auth/reauth");
    expect(loc.searchParams.get("return")).toBe("/");
  });

  it("clears but does NOT redirect on the re-auth surface itself (no loop)", async () => {
    invalidSession();
    const res = await proxy(req("ai-travelconcierge.com", "/auth/reauth", { cookie: COOKIE }));
    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get("sb-abc-auth-token")?.maxAge).toBe(0);
  });

  it("does NOT heal on a transient auth-server error (no mass logout)", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthRetryableFetchError("auth server unreachable", 0),
    });
    const res = await proxy(req("ai-travelconcierge.com", "/", { cookie: COOKIE }));
    expect(res.headers.get("location")).toBeNull();
    expect(mocks.applyRefreshedSession).toHaveBeenCalledTimes(1);
  });

  it("does NOT heal when no auth cookie is present (anonymous visitor)", async () => {
    invalidSession();
    const res = await proxy(req("ai-travelconcierge.com", "/"));
    expect(res.headers.get("location")).toBeNull();
    expect(mocks.applyRefreshedSession).toHaveBeenCalledTimes(1);
  });

  it("does NOT heal on /api/auth/* even with a dead session cookie (PKCE exemption)", async () => {
    // getUser is skipped entirely for /api/auth/*, so the heal can never fire
    // there — these routes own their own session/PKCE state. Pin it so a
    // refactor of the exemption can't silently start clobbering the cookie
    // mid-callback.
    invalidSession();
    const res = await proxy(req("ai-travelconcierge.com", "/api/auth/callback", { cookie: COOKIE }));
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get("sb-abc-auth-token")?.maxAge).not.toBe(0);
    expect(mocks.getUser).not.toHaveBeenCalled();
  });
});
