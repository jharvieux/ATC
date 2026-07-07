// §17.3 — OAuth initiation route (PKCE rewrite, #69).
//
// Two contracts pinned here:
//   1. Regression guard (#438): the route must NEVER set options.queryParams.state
//      — `state` is Supabase's PKCE/CSRF parameter. Clobbering it made Supabase
//      reject the provider callback and 404 the user at /auth/error.
//   2. Post-login redirect (#437): a SAFE same-app `redirect_to` rides the
//      callback URL as ?next=; unsafe (open-redirect) and auth-internal values
//      are dropped so login can't be turned into an open redirect or bounced
//      into the non-existent /auth/callback page.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mockSignInWithOAuth = vi.fn();

// The route now builds its client via @supabase/ssr through this helper; mock
// it so we assert the route's logic (provider gate, redirectTo, next) without a
// real Supabase client. applyAuthCookies is a passthrough — cookie wiring is
// covered by ssr-client.test.ts.
vi.mock("@/lib/auth/ssr-client", () => ({
  createRouteHandlerClient: () => ({
    supabase: { auth: { signInWithOAuth: mockSignInWithOAuth } },
    applyAuthCookies: <T>(res: T): T => res,
  }),
}));

// §28.9 / issue #1668 — ALLOWED_PROVIDERS is derived from these flags at
// request time. Default all three on (matches env.ts schema defaults); the
// dedicated describe block below flips them individually.
const envFlags = vi.hoisted(() => ({
  OAUTH_GOOGLE_ENABLED: true,
  OAUTH_MICROSOFT_ENABLED: true,
  OAUTH_FACEBOOK_ENABLED: true,
}));
vi.mock("@/lib/env", () => ({ env: () => envFlags }));

import { GET } from "@/app/api/auth/oauth-initiate/route";

beforeEach(() => {
  vi.clearAllMocks();
  envFlags.OAUTH_GOOGLE_ENABLED = true;
  envFlags.OAUTH_MICROSOFT_ENABLED = true;
  envFlags.OAUTH_FACEBOOK_ENABLED = true;
  mockSignInWithOAuth.mockResolvedValue({
    data: {
      url: "https://test.supabase.co/auth/v1/authorize?provider=google&state=server-issued",
    },
    error: null,
  });
});

function get(qs: string): Promise<Response> {
  return GET(
    new NextRequest(`https://ai-travelconcierge.com/api/auth/oauth-initiate${qs}`),
  );
}

function oauthArg(): {
  provider: string;
  options?: { redirectTo?: string; queryParams?: Record<string, string>; scopes?: string };
} {
  return mockSignInWithOAuth.mock.calls[0]?.[0];
}

describe("GET /api/auth/oauth-initiate", () => {
  it("rejects a missing provider with 400 and never calls Supabase", async () => {
    const res = await get("");
    expect(res.status).toBe(400);
    expect(mockSignInWithOAuth).not.toHaveBeenCalled();
  });

  it("rejects an unsupported provider (apple is deferred) with 400", async () => {
    const res = await get("?provider=apple");
    expect(res.status).toBe(400);
    expect(mockSignInWithOAuth).not.toHaveBeenCalled();
  });

  it("never overrides Supabase's reserved `state` parameter, even when redirect_to is present", async () => {
    await get("?provider=google&redirect_to=%2Fcrm%2Fbookings");
    expect(mockSignInWithOAuth).toHaveBeenCalledTimes(1);
    expect(oauthArg().provider).toBe("google");
    // The #438 guard is specifically "don't set `state`" — queryParams now
    // carries `prompt` (account chooser), so assert on the state key directly.
    expect(oauthArg().options?.queryParams?.state).toBeUndefined();
  });

  it("forces the provider account chooser with prompt=select_account so a signed-in user can pick a different account", async () => {
    await get("?provider=google");
    expect(oauthArg().options?.queryParams?.prompt).toBe("select_account");
    vi.clearAllMocks();
    mockSignInWithOAuth.mockResolvedValue({
      data: { url: "https://example.com" },
      error: null,
    });
    await get("?provider=azure");
    expect(oauthArg().options?.queryParams?.prompt).toBe("select_account");
  });

  it("points redirectTo at /api/auth/callback on the request origin", async () => {
    await get("?provider=azure");
    expect(oauthArg().options?.redirectTo).toBe(
      "https://ai-travelconcierge.com/api/auth/callback",
    );
  });

  it("forwards a safe relative redirect_to as ?next= on the callback URL (#437)", async () => {
    await get("?provider=google&redirect_to=%2Fcrm%2Fbookings");
    const redirectTo = new URL(oauthArg().options!.redirectTo!);
    expect(redirectTo.pathname).toBe("/api/auth/callback");
    expect(redirectTo.searchParams.get("next")).toBe("/crm/bookings");
  });

  it("drops an open-redirect redirect_to (//evil.com) — no next param", async () => {
    await get("?provider=google&redirect_to=%2F%2Fevil.com");
    const redirectTo = new URL(oauthArg().options!.redirectTo!);
    expect(redirectTo.searchParams.has("next")).toBe(false);
  });

  it("drops an auth-internal redirect_to (the signup page's legacy /auth/callback value)", async () => {
    await get("?provider=google&redirect_to=%2Fauth%2Fcallback%3Fflow%3Dcustomer");
    const redirectTo = new URL(oauthArg().options!.redirectTo!);
    expect(redirectTo.searchParams.has("next")).toBe(false);
  });

  it("302-redirects to the Supabase-issued authorize URL", async () => {
    const res = await get("?provider=google");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://test.supabase.co/auth/v1/authorize?provider=google&state=server-issued",
    );
  });

  it("returns 500 when Supabase cannot produce a redirect URL", async () => {
    mockSignInWithOAuth.mockResolvedValue({ data: { url: null }, error: { message: "boom" } });
    const res = await get("?provider=facebook");
    expect(res.status).toBe(500);
  });

  // §17.2 — Azure requires `email User.Read` scopes so Microsoft includes the
  // email claim in the OIDC id_token. Without them Supabase throws
  // "Error getting user email from external provider" before our callback runs.
  it("sends email+User.Read scopes for Azure to force Microsoft to include the email claim", async () => {
    await get("?provider=azure");
    expect(oauthArg().options?.scopes).toBe("email User.Read");
  });

  it("does not send extra scopes for non-Azure providers", async () => {
    await get("?provider=google");
    expect(oauthArg().options?.scopes).toBeUndefined();
    vi.clearAllMocks();
    mockSignInWithOAuth.mockResolvedValue({ data: { url: "https://example.com" }, error: null });
    await get("?provider=facebook");
    expect(oauthArg().options?.scopes).toBeUndefined();
  });
});

// §28.9 / issue #1668 — ALLOWED_PROVIDERS is now derived from the
// OAUTH_*_ENABLED flags at request time instead of being hardcoded.
describe("GET /api/auth/oauth-initiate — provider gated by OAUTH_*_ENABLED (#1668)", () => {
  it("OAUTH_GOOGLE_ENABLED=false rejects provider=google with 400", async () => {
    envFlags.OAUTH_GOOGLE_ENABLED = false;
    const res = await get("?provider=google");
    expect(res.status).toBe(400);
    expect(mockSignInWithOAuth).not.toHaveBeenCalled();
  });

  it("OAUTH_GOOGLE_ENABLED=true (default) allows provider=google", async () => {
    envFlags.OAUTH_GOOGLE_ENABLED = true;
    const res = await get("?provider=google");
    expect(res.status).toBe(302);
    expect(mockSignInWithOAuth).toHaveBeenCalledTimes(1);
  });

  it("OAUTH_FACEBOOK_ENABLED=false rejects provider=facebook with 400", async () => {
    envFlags.OAUTH_FACEBOOK_ENABLED = false;
    const res = await get("?provider=facebook");
    expect(res.status).toBe(400);
    expect(mockSignInWithOAuth).not.toHaveBeenCalled();
  });

  it("OAUTH_FACEBOOK_ENABLED=true (default) allows provider=facebook", async () => {
    envFlags.OAUTH_FACEBOOK_ENABLED = true;
    const res = await get("?provider=facebook");
    expect(res.status).toBe(302);
    expect(mockSignInWithOAuth).toHaveBeenCalledTimes(1);
  });

  // Microsoft's dangerous half-wired state (#1668): OAUTH_MICROSOFT_ENABLED
  // already gates MS Graph creds via superRefine at boot but did NOT gate
  // this route — disabling it left the login button live with no creds
  // underneath. Both must now agree.
  it("OAUTH_MICROSOFT_ENABLED=false rejects provider=azure with 400", async () => {
    envFlags.OAUTH_MICROSOFT_ENABLED = false;
    const res = await get("?provider=azure");
    expect(res.status).toBe(400);
    expect(mockSignInWithOAuth).not.toHaveBeenCalled();
  });

  it("OAUTH_MICROSOFT_ENABLED=true (default) allows provider=azure", async () => {
    envFlags.OAUTH_MICROSOFT_ENABLED = true;
    const res = await get("?provider=azure");
    expect(res.status).toBe(302);
    expect(mockSignInWithOAuth).toHaveBeenCalledTimes(1);
  });
});

// tenant_host — platform-callback misdirect fix.
//
// When a tenant-subdomain user logs in via Google, the OAuth callback must land
// on the platform domain (only one URL registered in Supabase Auth), then redirect
// to the tenant subdomain. The tenant hostname is carried through the OAuth round-
// trip as `tenant_host` in the callbackUrl so the callback knows where to redirect.
describe("GET /api/auth/oauth-initiate — tenant_host subdomain fix", () => {
  function getFrom(origin: string, qs: string): Promise<Response> {
    return GET(new NextRequest(`${origin}/api/auth/oauth-initiate${qs}`));
  }

  beforeEach(() => {
    process.env.PLATFORM_PRIMARY_DOMAIN = "atcadventures.com";
    mockSignInWithOAuth.mockResolvedValue({ data: { url: "https://example.com" }, error: null });
  });

  afterEach(() => {
    delete process.env.PLATFORM_PRIMARY_DOMAIN;
  });

  it("callback URL uses platform domain, not the tenant subdomain", async () => {
    await getFrom("https://lisa-travel.atcadventures.com", "?provider=google");
    const redirectTo = new URL(oauthArg().options!.redirectTo!);
    expect(redirectTo.host).toBe("atcadventures.com");
  });

  it("adds tenant_host param when request came from a tenant subdomain", async () => {
    await getFrom("https://lisa-travel.atcadventures.com", "?provider=google");
    const redirectTo = new URL(oauthArg().options!.redirectTo!);
    expect(redirectTo.searchParams.get("tenant_host")).toBe("lisa-travel.atcadventures.com");
  });

  it("no tenant_host param when request came from the platform domain", async () => {
    await getFrom("https://atcadventures.com", "?provider=google");
    const redirectTo = new URL(oauthArg().options!.redirectTo!);
    expect(redirectTo.searchParams.has("tenant_host")).toBe(false);
  });
});
