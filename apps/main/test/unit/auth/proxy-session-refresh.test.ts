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

vi.mock("@/lib/auth/ssr-client", () => ({
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
