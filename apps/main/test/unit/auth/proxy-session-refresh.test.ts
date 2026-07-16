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
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({
  getTenantBySlug: vi.fn(),
  getTenantByCustomDomain: vi.fn(),
  getTenantByAuthUserId: vi.fn(),
  getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
  // #1932 hybrid — default is a clean local miss ({data:null}), which hands
  // off to getUser(). That makes every pre-existing test in this file exercise
  // the handoff path, i.e. exactly the pre-#1932 network behavior they pin.
  getClaims: vi.fn().mockResolvedValue({ data: null, error: null }),
  applyRefreshedSession: vi.fn(<T>(res: T): T => res),
}));

vi.mock("@/lib/tenancy/resolve-tenant", () => ({
  getTenantBySlug: mocks.getTenantBySlug,
  getTenantByCustomDomain: mocks.getTenantByCustomDomain,
  getTenantByAuthUserId: mocks.getTenantByAuthUserId,
}));

// Keep the real isInvalidSessionError + clearAuthCookies (the self-heal logic
// under test); only the client factory is stubbed so we can drive getUser().
vi.mock("@/lib/auth/ssr-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/ssr-client")>()),
  createMiddlewareClient: () => ({
    supabase: { auth: { getUser: mocks.getUser, getClaims: mocks.getClaims } },
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
  mocks.getClaims.mockResolvedValue({ data: null, error: null });
  mocks.getTenantByAuthUserId.mockResolvedValue(null);
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
      expect(mocks.getClaims, `getClaims should not be called for ${p}`).not.toHaveBeenCalled();
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
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get("sb-abc-auth-token")?.maxAge).toBe(0);
  });

  it("clears in place (no redirect) across the signup funnel, but redirects on /signup/complete", async () => {
    // Pre-auth signup pages are part of the sign-in surface: clear the dead
    // cookie and let the funnel continue. /signup/complete is login-gated
    // (#1050) — it needs a live session, so it must re-auth instead.
    for (const p of ["/signup", "/signup/email-verify", "/signup/email-prompt"]) {
      invalidSession();
      const res = await proxy(req("ai-travelconcierge.com", p, { cookie: COOKIE }));
      expect(res.status, p).toBe(200);
      expect(res.headers.get("location"), p).toBeNull();
      expect(res.cookies.get("sb-abc-auth-token")?.maxAge, p).toBe(0);
    }

    invalidSession();
    const complete = await proxy(req("ai-travelconcierge.com", "/signup/complete", { cookie: COOKIE }));
    expect(complete.status).toBe(307);
    expect(new URL(complete.headers.get("location")!).pathname).toBe("/auth/reauth");
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

// #1932 — hybrid local verification. The hot path verifies the session JWT
// locally (verifyIdentity → getClaims, ES256 vs cached JWKS) and only pays the
// getUser() network round-trip when the local verify misses. These tests pin
// the load-bearing invariants: a local success must never call getUser, every
// local miss must hand off to getUser (whose error alone drives the #1361
// heal), and the kill switch must restore the unconditional-getUser behavior.
describe("proxy() hybrid local verification (#1932)", () => {
  const COOKIE = "sb-abc-auth-token=live-token";
  function localVerified(sub = "user-1") {
    mocks.getClaims.mockResolvedValue({
      data: { claims: { sub, exp: Math.floor(Date.now() / 1000) + 3600 } },
      error: null,
    });
  }

  it("locally-verified session: getUser is NOT called, and the response still passes through applyRefreshedSession", async () => {
    localVerified();
    const res = await proxy(req("ai-travelconcierge.com", "/", { cookie: COOKIE }));
    expect(mocks.getClaims).toHaveBeenCalledTimes(1);
    expect(mocks.getUser).not.toHaveBeenCalled();
    // A refresh can happen INSIDE getClaims (getSession auto-refreshes within
    // its 90s margin); applyRefreshedSession must still wrap the response so
    // any rotation is flushed.
    expect(mocks.applyRefreshedSession).toHaveBeenCalledTimes(1);
    expect(mocks.applyRefreshedSession.mock.calls[0]?.[0]).toBe(res);
  });

  it("locally-verified identity feeds tenant resolution with the verified sub", async () => {
    localVerified("user-42");
    await proxy(req("ai-travelconcierge.com", "/concierge", { cookie: COOKIE }));
    expect(mocks.getTenantByAuthUserId).toHaveBeenCalledWith("user-42");
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("login gate behaves identically under local verification: verified passes, unverified redirects", async () => {
    localVerified();
    const authed = await proxy(req("ai-travelconcierge.com", "/signup/complete", { cookie: COOKIE }));
    expect(authed.status).toBe(200);
    expect(authed.headers.get("location")).toBeNull();

    vi.clearAllMocks();
    mocks.getClaims.mockResolvedValue({ data: null, error: null });
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    mocks.applyRefreshedSession.mockImplementation(<T>(r: T): T => r);
    const anon = await proxy(req("ai-travelconcierge.com", "/signup/complete"));
    expect(anon.status).toBe(307);
    expect(new URL(anon.headers.get("location")!).pathname).toBe("/auth/reauth");
  });

  it("local-verify miss hands off to getUser; a definitive getUser rejection still heals (server-rejected token)", async () => {
    mocks.getClaims.mockResolvedValue({
      data: null,
      // Shape-only stand-in for AuthInvalidJwtError: local errors must NOT
      // drive the heal directly — only the getUser() handoff result may.
      error: Object.assign(new Error("Invalid JWT signature"), { name: "AuthInvalidJwtError" }),
    });
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError("invalid claim", 403, "bad_jwt"),
    });
    const res = await proxy(req("ai-travelconcierge.com", "/admin", { cookie: COOKIE }));
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/auth/reauth");
    expect(res.cookies.get("sb-abc-auth-token")?.maxAge).toBe(0);
  });

  it("dead-refresh-token inside getClaims still heals: the handoff sees AuthSessionMissingError, not AuthApiError (the _removeSession seam)", async () => {
    // Faithful sequencing of the real auth-js integration (PR #1987 audit
    // finding): a dead/rotated refresh token fails the refresh INSIDE
    // getClaims, whose _callRefreshToken runs _removeSession() before
    // returning — so the handoff getUser() reads EMPTY session storage and
    // reports AuthSessionMissingError. The pre-#1932 single getUser() would
    // have surfaced the refresh's AuthApiError here; the heal must treat
    // session-missing-with-cookie-present as equally definitive or the #1361
    // redirect silently dies for its primary scenario.
    mocks.getClaims.mockResolvedValue({
      data: null,
      error: new AuthApiError("Invalid Refresh Token: Already Used", 400, "refresh_token_already_used"),
    });
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthSessionMissingError(),
    });
    const res = await proxy(req("ai-travelconcierge.com", "/admin", { cookie: COOKIE }));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/auth/reauth");
    expect(res.cookies.get("sb-abc-auth-token")?.maxAge).toBe(0);
  });

  it("AuthSessionMissingError WITHOUT an auth cookie does not heal (anonymous visitors are untouched)", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthSessionMissingError(),
    });
    const res = await proxy(req("ai-travelconcierge.com", "/"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("local-verify miss + transient getUser failure does NOT heal (no mass logout on an auth-server blip)", async () => {
    mocks.getClaims.mockResolvedValue({
      data: null,
      error: Object.assign(new Error("JWKS fetch failed"), { name: "AuthInvalidJwtError" }),
    });
    mocks.getUser.mockResolvedValue({
      data: { user: null },
      error: new AuthRetryableFetchError("auth server unreachable", 0),
    });
    const res = await proxy(req("ai-travelconcierge.com", "/", { cookie: COOKIE }));
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get("sb-abc-auth-token")?.maxAge).not.toBe(0);
  });

  it("getClaims THROWING (exotic decode failure rethrows non-AuthErrors) hands off to getUser instead of crashing", async () => {
    mocks.getClaims.mockRejectedValue(new SyntaxError("Unexpected token in JSON"));
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    const res = await proxy(req("ai-travelconcierge.com", "/", { cookie: COOKIE }));
    expect(res.status).toBe(200);
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
  });

  it("kill switch AUTH_MIDDLEWARE_LOCAL_VERIFY_DISABLED=true restores unconditional getUser (no getClaims call)", async () => {
    process.env.AUTH_MIDDLEWARE_LOCAL_VERIFY_DISABLED = "true";
    localVerified(); // would succeed locally — must be ignored
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    await proxy(req("ai-travelconcierge.com", "/", { cookie: COOKIE }));
    expect(mocks.getClaims).not.toHaveBeenCalled();
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
  });
});
