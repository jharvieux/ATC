// §17.3 — OAuth initiation route.
//
// Regression guard for the Google-login failure: the route used to inject its
// own `state` queryParam (from redirect_to), which clobbered Supabase's
// PKCE/CSRF state. Supabase then rejected the provider callback with
// "OAuth state parameter is invalid" and the user 404'd at /auth/error.
// `state` must be owned by Supabase — the route must never set it.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSignInWithOAuth = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { signInWithOAuth: mockSignInWithOAuth } }),
}));

import { GET } from "@/app/api/auth/oauth-initiate/route";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = {
    ...ORIGINAL_ENV,
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  };
  mockSignInWithOAuth.mockResolvedValue({
    data: { url: "https://test.supabase.co/auth/v1/authorize?provider=google&state=server-issued" },
    error: null,
  });
});

function get(qs: string): Promise<Response> {
  return GET(new Request(`https://ai-travelconcierge.com/api/auth/oauth-initiate${qs}`));
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
    const arg = mockSignInWithOAuth.mock.calls[0]?.[0] as
      | { provider: string; options?: { queryParams?: Record<string, string> } }
      | undefined;
    expect(arg?.provider).toBe("google");
    expect(arg?.options?.queryParams).toBeUndefined();
  });

  it("points redirectTo at /api/auth/callback on the request origin", async () => {
    await get("?provider=azure");
    const arg = mockSignInWithOAuth.mock.calls[0]?.[0] as
      | { options?: { redirectTo?: string } }
      | undefined;
    expect(arg?.options?.redirectTo).toBe("https://ai-travelconcierge.com/api/auth/callback");
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
