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

import { describe, it, expect, vi, beforeEach } from "vitest";
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

import { GET } from "@/app/api/auth/oauth-initiate/route";

beforeEach(() => {
  vi.clearAllMocks();
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
  options?: { redirectTo?: string; queryParams?: Record<string, string> };
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
    expect(oauthArg().options?.queryParams).toBeUndefined();
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
});
