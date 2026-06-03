// Unit tests for the exported `proxy()` function in apps/main/src/proxy.ts.
//
// The integration test (apps/main/test/integration/proxy.test.ts) covers
// the DB-touching helpers (getTenantBySlug, getTenantByCustomDomain) and a
// few regex/hostname patterns. This file mocks those helpers and exercises
// the proxy function itself — the admin gate, the test-bypass gate,
// platform domain routing, subdomain → tenant resolution, custom-domain
// fallback, payment gate side effects, and the 404 fallthrough.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getTenantBySlug: vi.fn(),
  getTenantByCustomDomain: vi.fn(),
  getTenantByAuthUserId: vi.fn(),
  getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
}));

vi.mock("@/lib/tenancy/resolve-tenant", () => ({
  getTenantBySlug: mocks.getTenantBySlug,
  getTenantByCustomDomain: mocks.getTenantByCustomDomain,
  getTenantByAuthUserId: mocks.getTenantByAuthUserId,
}));

// Session refresh is exercised separately (proxy-session-refresh.test.ts);
// here we just want createMiddlewareClient to be a no-op so the gate +
// tenant-resolution logic this file owns runs untouched.
vi.mock("@/lib/auth/ssr-client", () => ({
  createMiddlewareClient: () => ({
    supabase: { auth: { getUser: mocks.getUser } },
    applyRefreshedSession: <T>(res: T): T => res,
  }),
}));

import { proxy } from "@/proxy";

const ORIG_ENV = { ...process.env };

function payingTenant(overrides: Record<string, unknown> = {}) {
  return {
    id: "tenant-1",
    tenant_type: "sub_pro",
    subscription_status: "active",
    non_paying_since: null,
    status: "active",
    ...overrides,
  };
}

function makeReq(opts: { host: string; pathname?: string; headers?: Record<string, string> } = { host: "atc-tenant1.ai-travelconcierge.com" }): NextRequest {
  const url = `http://${opts.host}${opts.pathname ?? "/"}`;
  const headers = new Headers(opts.headers ?? {});
  headers.set("host", opts.host);
  return new NextRequest(url, { headers });
}

describe("proxy()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PLATFORM_PRIMARY_DOMAIN = "ai-travelconcierge.com";
    process.env.PLATFORM_DOMAIN_REGEX = "^atc-([a-z0-9-]+)\\.ai-travelconcierge\\.com$";
    delete process.env.TEST_AUTH_BYPASS_TOKEN;
    delete process.env.TEST_AUTH_BYPASS_TENANT_ID;
    delete process.env.MAIN_APP_ADMIN_API_KEY;
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIG_ENV)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(ORIG_ENV)) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  // -- Admin API gate (§26) ------------------------------------------------

  describe("admin API gate", () => {
    it("rejects /api/admin/* with no Authorization header → 403 admin_gate_blocked", async () => {
      const res = await proxy(
        makeReq({ host: "ai-travelconcierge.com", pathname: "/api/admin/tenants" }),
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("admin_gate_blocked");
    });

    it("rejects /api/admin/* with non-Bearer Authorization → 403", async () => {
      const res = await proxy(
        makeReq({
          host: "ai-travelconcierge.com",
          pathname: "/api/admin/tenants",
          headers: { authorization: "Basic abc123" },
        }),
      );
      expect(res.status).toBe(403);
    });

    it("rejects /api/admin/* with a one-segment 'JWT' → 403", async () => {
      const res = await proxy(
        makeReq({
          host: "ai-travelconcierge.com",
          pathname: "/api/admin/tenants",
          headers: { authorization: "Bearer not-a-jwt" },
        }),
      );
      expect(res.status).toBe(403);
    });

    it("accepts /api/admin/* when a Supabase auth cookie is present (§17.x posture)", async () => {
      const res = await proxy(
        makeReq({
          host: "ai-travelconcierge.com",
          pathname: "/api/admin/tenants",
          headers: { cookie: "sb-abcdef-auth-token=opaque-session-blob" },
        }),
      );
      expect(res.status).not.toBe(403);
    });

    it("accepts /api/admin/* with chunked Supabase auth cookies (sb-<ref>-auth-token.0)", async () => {
      const res = await proxy(
        makeReq({
          host: "ai-travelconcierge.com",
          pathname: "/api/admin/tenants",
          headers: {
            cookie: "sb-abcdef-auth-token.0=chunkA; sb-abcdef-auth-token.1=chunkB",
          },
        }),
      );
      expect(res.status).not.toBe(403);
    });

    it("rejects /api/admin/* with a Bearer JWT but no auth cookie (legacy human-admin path is gone)", async () => {
      const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signaturePart";
      const res = await proxy(
        makeReq({
          host: "ai-travelconcierge.com",
          pathname: "/api/admin/tenants",
          headers: { authorization: `Bearer ${fakeJwt}` },
        }),
      );
      expect(res.status).toBe(403);
    });

    it("accepts /api/admin/* with the service-to-service MAIN_APP_ADMIN_API_KEY", async () => {
      process.env.MAIN_APP_ADMIN_API_KEY = "service-key-xyz";
      const res = await proxy(
        makeReq({
          host: "ai-travelconcierge.com",
          pathname: "/api/admin/tenants",
          headers: { authorization: "Bearer service-key-xyz" },
        }),
      );
      expect(res.status).not.toBe(403);
    });

    it("rejects /api/admin/* with serviceKey set but a non-matching non-JWT token", async () => {
      // Locks `serviceKey && token === serviceKey` — a mutation to `||`
      // would let any token through when the service key env var is set.
      process.env.MAIN_APP_ADMIN_API_KEY = "service-key-xyz";
      const res = await proxy(
        makeReq({
          host: "ai-travelconcierge.com",
          pathname: "/api/admin/tenants",
          headers: { authorization: "Bearer not-the-service-key" },
        }),
      );
      expect(res.status).toBe(403);
    });

    it("does NOT apply the admin gate to /api/tenant/* or other non-admin paths", async () => {
      // On platform domain with no admin path, gate not invoked.
      const res = await proxy(
        makeReq({
          host: "ai-travelconcierge.com",
          pathname: "/api/health",
        }),
      );
      // Should fall through to platform-sentinel header path, not 403.
      expect(res.status).not.toBe(403);
    });
  });

  // -- Admin PAGE gate (§26, defense-in-depth) ----------------------------

  describe("admin page gate", () => {
    const COOKIE = "sb-abcdef-auth-token=opaque-session-blob";

    it("404s /supervisor on the platform host with no session cookie", async () => {
      const res = await proxy(
        makeReq({ host: "ai-travelconcierge.com", pathname: "/supervisor" }),
      );
      expect(res.status).toBe(404);
    });

    it("404s /admin/* on the platform host with no session cookie", async () => {
      const res = await proxy(
        makeReq({ host: "ai-travelconcierge.com", pathname: "/admin/denylist" }),
      );
      expect(res.status).toBe(404);
    });

    it("lets /supervisor through on the platform host WITH a session cookie", async () => {
      // Locks the !hasSupabaseAuthCookie half: a present cookie must not 404.
      // Authoritative platform_admins membership is checked in the layout, not here.
      const res = await proxy(
        makeReq({
          host: "ai-travelconcierge.com",
          pathname: "/supervisor",
          headers: { cookie: COOKIE },
        }),
      );
      expect(res.status).not.toBe(404);
      expect(res.headers.get("x-middleware-next")).toBe("1");
      expect(res.headers.get("x-middleware-request-x-resolved-tenant-id")).toBe("platform");
    });

    it("404s /admin on a tenant host even WITH a session cookie (platform-only)", async () => {
      // Locks the hostname !== primaryDomain half: admin pages must never be
      // served on tenant subdomains, regardless of session.
      mocks.getTenantBySlug.mockResolvedValue(payingTenant());
      const res = await proxy(
        makeReq({
          host: "atc-tenant1.ai-travelconcierge.com",
          pathname: "/admin",
          headers: { cookie: COOKIE },
        }),
      );
      expect(res.status).toBe(404);
    });

    it("404s /supervisor on a custom domain host", async () => {
      mocks.getTenantByCustomDomain.mockResolvedValue(
        payingTenant({ id: "tenant-2", tenant_type: "byo_agency" }),
      );
      const res = await proxy(
        makeReq({
          host: "agency.example.com",
          pathname: "/supervisor",
          headers: { cookie: COOKIE },
        }),
      );
      expect(res.status).toBe(404);
    });

    it("does NOT gate non-admin pages on the platform host", async () => {
      // A page request with no cookie on the platform host that ISN'T an admin
      // page must still pass through (proves the gate is scoped to admin paths).
      const res = await proxy(
        makeReq({ host: "ai-travelconcierge.com", pathname: "/some-public-page" }),
      );
      expect(res.status).not.toBe(404);
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });
  });

  // -- Platform domain → "platform" sentinel ------------------------------

  describe("platform domain", () => {
    it("returns next() with x-resolved-tenant-id='platform' header for non-chat paths", async () => {
      const res = await proxy(makeReq({ host: "ai-travelconcierge.com" }));
      expect(res.headers.get("x-middleware-next")).toBe("1");
      // Validates the platform sentinel propagates.
      expect(res.headers.get("x-middleware-request-x-resolved-tenant-id")).toBe("platform");
      expect(res.headers.get("x-middleware-request-x-resolved-tenant-type")).toBe("platform");
    });

    it("sets platform sentinel on /chat when user is unauthenticated", async () => {
      // getUser returns null (default) → no tenant lookup, sentinel falls through.
      mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
      const res = await proxy(makeReq({ host: "ai-travelconcierge.com", pathname: "/chat" }));
      expect(res.headers.get("x-middleware-request-x-resolved-tenant-id")).toBe("platform");
      expect(mocks.getTenantByAuthUserId).not.toHaveBeenCalled();
    });

    it("resolves user's tenant for /chat when authenticated, forwarding a real tenant ID", async () => {
      mocks.getUser.mockResolvedValue({ data: { user: { id: "auth-user-1" } }, error: null });
      mocks.getTenantByAuthUserId.mockResolvedValue(payingTenant());
      const res = await proxy(makeReq({ host: "ai-travelconcierge.com", pathname: "/chat" }));
      expect(mocks.getTenantByAuthUserId).toHaveBeenCalledWith("auth-user-1");
      expect(res.headers.get("x-middleware-request-x-resolved-tenant-id")).toBe("tenant-1");
      expect(res.headers.get("x-middleware-request-x-resolved-tenant-type")).toBe("sub_pro");
    });

    it("resolves tenant for /api/chat/conversations on platform domain", async () => {
      mocks.getUser.mockResolvedValue({ data: { user: { id: "auth-user-1" } }, error: null });
      mocks.getTenantByAuthUserId.mockResolvedValue(payingTenant());
      const res = await proxy(makeReq({ host: "ai-travelconcierge.com", pathname: "/api/chat/conversations" }));
      expect(mocks.getTenantByAuthUserId).toHaveBeenCalled();
      expect(res.headers.get("x-middleware-request-x-resolved-tenant-id")).toBe("tenant-1");
    });

    it("resolves tenant for /api/memory on platform domain", async () => {
      mocks.getUser.mockResolvedValue({ data: { user: { id: "auth-user-1" } }, error: null });
      mocks.getTenantByAuthUserId.mockResolvedValue(payingTenant());
      const res = await proxy(makeReq({ host: "ai-travelconcierge.com", pathname: "/api/memory" }));
      expect(mocks.getTenantByAuthUserId).toHaveBeenCalled();
      expect(res.headers.get("x-middleware-request-x-resolved-tenant-id")).toBe("tenant-1");
    });

    it("falls back to platform sentinel on /chat when authenticated user has no tenant", async () => {
      mocks.getUser.mockResolvedValue({ data: { user: { id: "auth-user-1" } }, error: null });
      mocks.getTenantByAuthUserId.mockResolvedValue(null);
      const res = await proxy(makeReq({ host: "ai-travelconcierge.com", pathname: "/chat" }));
      expect(res.headers.get("x-middleware-request-x-resolved-tenant-id")).toBe("platform");
    });

    it("falls back to platform sentinel on /chat when getTenantByAuthUserId throws (fail-closed on DB error)", async () => {
      // Locks fail-closed: a DB error must not silently forward an incorrect tenant.
      mocks.getUser.mockResolvedValue({ data: { user: { id: "auth-user-1" } }, error: null });
      mocks.getTenantByAuthUserId.mockRejectedValue(new Error("connection refused"));
      const res = await proxy(makeReq({ host: "ai-travelconcierge.com", pathname: "/chat" }));
      // Falls back to platform sentinel — chat route will return 400 tenant_not_resolved,
      // which is the correct denial behavior on DB error.
      expect(res.headers.get("x-middleware-request-x-resolved-tenant-id")).toBe("platform");
    });

    it("does NOT invoke getTenantByAuthUserId for non-chat platform-domain paths", async () => {
      mocks.getUser.mockResolvedValue({ data: { user: { id: "auth-user-1" } }, error: null });
      await proxy(makeReq({ host: "ai-travelconcierge.com", pathname: "/for-agencies" }));
      expect(mocks.getTenantByAuthUserId).not.toHaveBeenCalled();
    });
  });

  // -- Subdomain → slug lookup --------------------------------------------

  describe("subdomain → tenant slug resolution", () => {
    it("resolves slug via getTenantBySlug, sets headers", async () => {
      mocks.getTenantBySlug.mockResolvedValue(payingTenant());
      const res = await proxy(makeReq({ host: "atc-tenant1.ai-travelconcierge.com" }));
      expect(mocks.getTenantBySlug).toHaveBeenCalledWith("tenant1");
      expect(res.headers.get("x-middleware-request-x-resolved-tenant-id")).toBe("tenant-1");
      expect(res.headers.get("x-middleware-request-x-resolved-tenant-type")).toBe("sub_pro");
    });

    it("returns 404 when slug doesn't resolve to any tenant", async () => {
      mocks.getTenantBySlug.mockResolvedValue(null);
      const res = await proxy(makeReq({ host: "atc-ghost.ai-travelconcierge.com" }));
      expect(res.status).toBe(404);
    });

    it("returns 404 when getTenantBySlug throws (DB error)", async () => {
      mocks.getTenantBySlug.mockRejectedValue(new Error("db connection refused"));
      const res = await proxy(makeReq({ host: "atc-tenant1.ai-travelconcierge.com" }));
      expect(res.status).toBe(404);
    });

    it("strips port from hostname before matching", async () => {
      mocks.getTenantBySlug.mockResolvedValue(payingTenant());
      await proxy(makeReq({ host: "atc-tenant1.ai-travelconcierge.com:3000" }));
      // Port shouldn't break the regex match.
      expect(mocks.getTenantBySlug).toHaveBeenCalledWith("tenant1");
    });
  });

  // -- Custom domain fallback ---------------------------------------------

  describe("custom domain fallback", () => {
    it("resolves via getTenantByCustomDomain when no subdomain match", async () => {
      mocks.getTenantByCustomDomain.mockResolvedValue(
        payingTenant({ id: "tenant-2", tenant_type: "byo_agency" }),
      );
      const res = await proxy(makeReq({ host: "agency.example.com" }));
      expect(mocks.getTenantByCustomDomain).toHaveBeenCalledWith("agency.example.com");
      expect(res.headers.get("x-middleware-request-x-resolved-tenant-id")).toBe("tenant-2");
      expect(res.headers.get("x-middleware-request-x-resolved-tenant-type")).toBe("byo_agency");
    });

    it("returns 404 when custom domain doesn't resolve", async () => {
      mocks.getTenantByCustomDomain.mockResolvedValue(null);
      const res = await proxy(makeReq({ host: "nothing.example.com" }));
      expect(res.status).toBe(404);
    });

    it("returns 404 when getTenantByCustomDomain throws", async () => {
      mocks.getTenantByCustomDomain.mockRejectedValue(new Error("rls denied"));
      const res = await proxy(makeReq({ host: "boom.example.com" }));
      expect(res.status).toBe(404);
    });
  });

  // -- Payment gate (§15.16) ----------------------------------------------

  describe("payment gate", () => {
    it("paying tenant: x-payment-banner-state header is empty", async () => {
      mocks.getTenantBySlug.mockResolvedValue(payingTenant());
      const res = await proxy(makeReq({ host: "atc-tenant1.ai-travelconcierge.com" }));
      expect(res.headers.get("x-payment-banner-state")).toBe("");
    });

    it("within-grace non-paying tenant: banner state is 'within_grace', no redirect", async () => {
      const nonPaying = payingTenant({
        subscription_status: "past_due",
        non_paying_since: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      });
      mocks.getTenantBySlug.mockResolvedValue(nonPaying);
      const res = await proxy(makeReq({ host: "atc-tenant1.ai-travelconcierge.com", pathname: "/dashboard" }));
      expect(res.headers.get("x-payment-banner-state")).toBe("within_grace");
      // No redirect — within grace lets the request through.
      expect(res.headers.get("location")).toBeNull();
    });

    it("past-grace non-paying tenant on a non-exempt path: redirects to /settings/billing?gate=past_grace", async () => {
      const nonPaying = payingTenant({
        subscription_status: "canceled",
        non_paying_since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
      mocks.getTenantBySlug.mockResolvedValue(nonPaying);
      const res = await proxy(makeReq({ host: "atc-tenant1.ai-travelconcierge.com", pathname: "/dashboard" }));
      const location = res.headers.get("location");
      expect(location).toContain("/settings/billing");
      expect(location).toContain("gate=past_grace");
    });

    it("past-grace tenant on /settings/billing IS allowed through (exempt)", async () => {
      const nonPaying = payingTenant({
        subscription_status: "canceled",
        non_paying_since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
      mocks.getTenantBySlug.mockResolvedValue(nonPaying);
      const res = await proxy(makeReq({ host: "atc-tenant1.ai-travelconcierge.com", pathname: "/settings/billing" }));
      // Banner header reflects past-grace, but no redirect.
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("x-payment-banner-state")).toBe("past_grace");
    });

    it("past-grace tenant on /api/webhooks/stripe IS allowed through (exempt)", async () => {
      const nonPaying = payingTenant({
        subscription_status: "canceled",
        non_paying_since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
      mocks.getTenantBySlug.mockResolvedValue(nonPaying);
      const res = await proxy(makeReq({
        host: "atc-tenant1.ai-travelconcierge.com",
        pathname: "/api/webhooks/stripe",
      }));
      expect(res.headers.get("location")).toBeNull();
    });

    it("past-grace tenant on /legal/* IS allowed through (exempt)", async () => {
      const nonPaying = payingTenant({
        subscription_status: "canceled",
        non_paying_since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
      mocks.getTenantBySlug.mockResolvedValue(nonPaying);
      const res = await proxy(makeReq({
        host: "atc-tenant1.ai-travelconcierge.com",
        pathname: "/legal/privacy",
      }));
      expect(res.headers.get("location")).toBeNull();
    });
  });

  // -- Test bypass (Tier-2 E2E) -------------------------------------------

  describe("test bypass", () => {
    it("ignores bypass token when env vars are unset", async () => {
      mocks.getTenantBySlug.mockResolvedValue(payingTenant());
      const res = await proxy(makeReq({
        host: "atc-tenant1.ai-travelconcierge.com",
        headers: { authorization: "Bearer any-old-token" },
      }));
      // No bypass → normal resolution path.
      expect(res.headers.get("x-middleware-request-x-resolved-tenant-id")).toBe("tenant-1");
    });

    it("activates bypass when token matches and env vars are set (non-prod)", async () => {
      // NODE_ENV defaults to test, VERCEL_ENV unset — bypass is allowed.
      process.env.TEST_AUTH_BYPASS_TOKEN = "test-bypass-secret";
      process.env.TEST_AUTH_BYPASS_TENANT_ID = "test-tenant-99";
      const res = await proxy(makeReq({
        host: "atc-tenant1.ai-travelconcierge.com",
        headers: { authorization: "Bearer test-bypass-secret" },
      }));
      expect(res.headers.get("x-middleware-request-x-resolved-tenant-id")).toBe("test-tenant-99");
      expect(res.headers.get("x-middleware-request-x-resolved-tenant-type")).toBe("byo_host");
    });

    it("rejects mismatched bypass token (constant-time compare)", async () => {
      process.env.TEST_AUTH_BYPASS_TOKEN = "test-bypass-secret";
      process.env.TEST_AUTH_BYPASS_TENANT_ID = "test-tenant-99";
      mocks.getTenantBySlug.mockResolvedValue(payingTenant());
      const res = await proxy(makeReq({
        host: "atc-tenant1.ai-travelconcierge.com",
        headers: { authorization: "Bearer different-token" },
      }));
      // Bypass didn't fire → normal slug lookup happened.
      expect(mocks.getTenantBySlug).toHaveBeenCalled();
      expect(res.headers.get("x-middleware-request-x-resolved-tenant-id")).toBe("tenant-1");
    });

    it("disables bypass when NODE_ENV='production' even if VERCEL_ENV is non-prod", async () => {
      // Locks the `NODE_ENV !== "production" && VERCEL_ENV !== "production"` AND check.
      // A mutation to `||` would activate bypass whenever EITHER is non-prod — defeating
      // the belt-and-suspenders posture from MEMORY audit Finding 3.
      // process.env.NODE_ENV is readonly in @types/node 22+; cast through
      // any to write. This is the standard workaround used in vitest
      // suites that exercise NODE_ENV-gated code paths.
      const env = process.env as Record<string, string | undefined>;
      const savedNode = env.NODE_ENV;
      const savedVercel = env.VERCEL_ENV;
      env.NODE_ENV = "production";
      env.VERCEL_ENV = "preview";
      env.TEST_AUTH_BYPASS_TOKEN = "test-bypass-secret";
      env.TEST_AUTH_BYPASS_TENANT_ID = "test-tenant-99";
      mocks.getTenantBySlug.mockResolvedValue(payingTenant());
      try {
        const res = await proxy(makeReq({
          host: "atc-tenant1.ai-travelconcierge.com",
          headers: { authorization: "Bearer test-bypass-secret" },
        }));
        // Bypass MUST NOT fire — should fall through to normal resolution.
        expect(res.headers.get("x-middleware-request-x-resolved-tenant-id")).toBe("tenant-1");
        expect(mocks.getTenantBySlug).toHaveBeenCalled();
      } finally {
        if (savedNode !== undefined) env.NODE_ENV = savedNode;
        else delete env.NODE_ENV;
        if (savedVercel !== undefined) env.VERCEL_ENV = savedVercel;
        else delete env.VERCEL_ENV;
      }
    });

    it("disables bypass when VERCEL_ENV='production' even if NODE_ENV is non-prod", async () => {
      // The other half of the AND. NODE_ENV being test-flavored shouldn't be
      // enough — VERCEL_ENV=production must independently block.
      const savedVercel = process.env.VERCEL_ENV;
      process.env.VERCEL_ENV = "production";
      process.env.TEST_AUTH_BYPASS_TOKEN = "test-bypass-secret";
      process.env.TEST_AUTH_BYPASS_TENANT_ID = "test-tenant-99";
      mocks.getTenantBySlug.mockResolvedValue(payingTenant());
      try {
        const res = await proxy(makeReq({
          host: "atc-tenant1.ai-travelconcierge.com",
          headers: { authorization: "Bearer test-bypass-secret" },
        }));
        expect(res.headers.get("x-middleware-request-x-resolved-tenant-id")).toBe("tenant-1");
      } finally {
        if (savedVercel !== undefined) process.env.VERCEL_ENV = savedVercel;
        else delete process.env.VERCEL_ENV;
      }
    });
  });
});
