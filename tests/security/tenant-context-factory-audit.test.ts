/**
 * §30.8 — TenantContext factory audit.
 *
 * Asserts every factory in apps/main/src/lib/db/factories.ts fails closed
 * on adversarial inputs. The factories are the only construction path for
 * a TenantContext (§5.4.5); any way to obtain a valid context for an
 * unauthorized scope is a tenant-isolation breach.
 *
 * These tests use lightweight in-test mocks rather than a live database —
 * each factory's authority check is exercised against the inputs that
 * would expose it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Provide the env the factories consult at import time.
const ORIGINAL_ENV = process.env;
beforeEach(() => {
  vi.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  };
});

// ---------------------------------------------------------------------------
// tenantContextFromRequest — HTTP-driven path
// ---------------------------------------------------------------------------

describe("tenantContextFromRequest — adversarial inputs", () => {
  it("throws when x-resolved-tenant-id header is missing", async () => {
    const { tenantContextFromRequest } = await import(
      "../../apps/main/src/lib/db/factories"
    );
    const req = new Request("https://atc.example/api/x", {
      headers: { authorization: "Bearer abc" },
    });
    await expect(tenantContextFromRequest(req)).rejects.toThrow(
      /missing x-resolved-tenant-id/i,
    );
  });

  it("throws when x-resolved-tenant-id is 'platform' (admin-route guard)", async () => {
    const { tenantContextFromRequest } = await import(
      "../../apps/main/src/lib/db/factories"
    );
    const req = new Request("https://atc.example/api/x", {
      headers: {
        "x-resolved-tenant-id": "platform",
        authorization: "Bearer abc",
      },
    });
    await expect(tenantContextFromRequest(req)).rejects.toThrow(
      /must use withPlatformAdminAudit/i,
    );
  });

  it("throws when env vars are unset (defensive — verifyEnvAtBoot is the primary gate)", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const { tenantContextFromRequest } = await import(
      "../../apps/main/src/lib/db/factories"
    );
    const req = new Request("https://atc.example/api/x", {
      headers: { "x-resolved-tenant-id": "tenant-uuid-here" },
    });
    await expect(tenantContextFromRequest(req)).rejects.toThrow(
      /Supabase env not configured/i,
    );
  });

  it("throws when the cookie session does not resolve to an auth user", async () => {
    vi.doMock("@/lib/auth/ssr-client", () => ({
      extractBearerToken: () => null,
      createBearerClient: () => ({}),
      createRequestScopedClient: () => ({
        auth: {
          getClaims: async () => ({ data: null, error: { message: "invalid jwt" } }),
          getSession: async () => ({ data: { session: null }, error: null }),
        },
        from: () => ({
          select: () => ({
            eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
          }),
        }),
      }),
    }));
    const { tenantContextFromRequest } = await import(
      "../../apps/main/src/lib/db/factories"
    );
    const req = new Request("https://atc.example/api/x", {
      headers: { "x-resolved-tenant-id": "tenant-uuid-here" },
    });
    await expect(tenantContextFromRequest(req)).rejects.toThrow(
      /invalid or expired access token/i,
    );
  });

  it("throws when authenticated user has no active membership in the resolved tenant", async () => {
    vi.doMock("@/lib/auth/ssr-client", () => ({
      extractBearerToken: () => null,
      createBearerClient: () => ({}),
      createRequestScopedClient: () => ({
        auth: {
          getClaims: async () => ({
            data: { claims: { sub: "auth-user-1" } },
            error: null,
          }),
          getSession: async () => ({
            data: { session: { access_token: "header.payload.sig" } },
            error: null,
          }),
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  // user is "suspended", not active — cross-tenant attempt
                  data: { id: "u1", status: "suspended" },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      }),
    }));
    const { tenantContextFromRequest } = await import(
      "../../apps/main/src/lib/db/factories"
    );
    const req = new Request("https://atc.example/api/x", {
      headers: { "x-resolved-tenant-id": "tenant-uuid-here" },
    });
    await expect(tenantContextFromRequest(req)).rejects.toThrow(
      /not an active member of the resolved tenant/i,
    );
  });

  it("throws when the user-row lookup itself errors", async () => {
    vi.doMock("@/lib/auth/ssr-client", () => ({
      extractBearerToken: () => null,
      createBearerClient: () => ({}),
      createRequestScopedClient: () => ({
        auth: {
          getClaims: async () => ({
            data: { claims: { sub: "auth-user-1" } },
            error: null,
          }),
          getSession: async () => ({
            data: { session: { access_token: "header.payload.sig" } },
            error: null,
          }),
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: null,
                  error: { message: "rls: blocked" },
                }),
              }),
            }),
          }),
        }),
      }),
    }));
    const { tenantContextFromRequest } = await import(
      "../../apps/main/src/lib/db/factories"
    );
    const req = new Request("https://atc.example/api/x", {
      headers: { "x-resolved-tenant-id": "tenant-uuid-here" },
    });
    await expect(tenantContextFromRequest(req)).rejects.toThrow(
      /failed to verify user-tenant membership/i,
    );
  });

  it("returns the resolved context when the cookie session names an active member (no Bearer required)", async () => {
    vi.doMock("@/lib/auth/ssr-client", () => ({
      extractBearerToken: () => null,
      createBearerClient: () => ({}),
      createRequestScopedClient: () => ({
        auth: {
          getClaims: async () => ({
            data: { claims: { sub: "auth-user-1" } },
            error: null,
          }),
          getSession: async () => ({
            data: { session: { access_token: "header.payload.sig" } },
            error: null,
          }),
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: "u1", status: "active" },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      }),
    }));
    const { tenantContextFromRequest } = await import(
      "../../apps/main/src/lib/db/factories"
    );
    const req = new Request("https://atc.example/api/x", {
      headers: { "x-resolved-tenant-id": "tenant-uuid-here" },
    });
    const ctx = await tenantContextFromRequest(req);
    expect(ctx.tenant_id).toBe("tenant-uuid-here");
    expect(ctx.source).toEqual({ kind: "http_request", user_id: "auth-user-1" });
  });

  it("uses bearer client when Authorization: Bearer header present, not cookie client", async () => {
    let cookieClientCalled = false;
    vi.doMock("@/lib/auth/ssr-client", () => ({
      extractBearerToken: (req: Request) => {
        const auth = req.headers.get("Authorization");
        return auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      },
      createBearerClient: () => ({
        auth: {
          getClaims: async (_token: string) => ({
            data: { claims: { sub: "auth-user-bearer" } },
            error: null,
          }),
          getSession: async () => ({
            data: { session: { access_token: "header.payload.sig" } },
            error: null,
          }),
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: "u-bearer", status: "active" },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      }),
      createRequestScopedClient: () => {
        cookieClientCalled = true;
        throw new Error("cookie client must not be called on bearer path");
      },
    }));
    const { tenantContextFromRequest } = await import(
      "../../apps/main/src/lib/db/factories"
    );
    const req = new Request("https://atc.example/api/x", {
      headers: {
        "x-resolved-tenant-id": "tenant-uuid-here",
        Authorization: "Bearer test-jwt",
      },
    });
    const ctx = await tenantContextFromRequest(req);
    expect(cookieClientCalled).toBe(false);
    expect(ctx.tenant_id).toBe("tenant-uuid-here");
    expect(ctx.source).toEqual({ kind: "http_request", user_id: "auth-user-bearer" });
  });

  // #1585 — this factory swapped its GoTrue getUser() round-trip for a local
  // JWKS signature check. The optimization is only sound if a token that fails
  // verification still yields NO context: a TenantContext is the app's proof of
  // authority (§5.4.5), so minting one from an unverified JWT would be a
  // tenant-isolation breach, not merely an auth bug. The membership row below
  // is deliberately active — the ONLY thing that may deny this request is the
  // failed signature check.
  it("throws when the bearer JWT's signature does not verify, even for an active member", async () => {
    vi.doMock("@/lib/auth/ssr-client", () => ({
      extractBearerToken: (req: Request) => {
        const auth = req.headers.get("Authorization");
        return auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      },
      createBearerClient: () => ({
        auth: {
          getClaims: async () => ({
            data: null,
            error: { name: "AuthInvalidJwtError", message: "Invalid JWT signature" },
          }),
          getSession: async () => ({ data: { session: null }, error: null }),
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: "u-bearer", status: "active", role: "tenant_owner" },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      }),
      createRequestScopedClient: () => ({}),
    }));
    const { tenantContextFromRequest } = await import(
      "../../apps/main/src/lib/db/factories"
    );
    const req = new Request("https://atc.example/api/x", {
      headers: {
        "x-resolved-tenant-id": "tenant-uuid-here",
        Authorization: "Bearer forged-jwt",
      },
    });
    await expect(tenantContextFromRequest(req)).rejects.toThrow(
      /invalid or expired access token/i,
    );
  });
});

// ---------------------------------------------------------------------------
// tenantContextFromInngestEvent — sync path
// ---------------------------------------------------------------------------

describe("tenantContextFromInngestEvent — adversarial inputs", () => {
  it("throws when event.data.tenant_id is missing", async () => {
    const { tenantContextFromInngestEvent } = await import(
      "../../apps/main/src/lib/db/factories"
    );
    expect(() =>
      tenantContextFromInngestEvent({
        id: "ev1",
        name: "some.event",
        data: {},
      }),
    ).toThrow(/tenant_id is missing or not a string/i);
  });

  it("throws when event.data.tenant_id is not a string (object)", async () => {
    const { tenantContextFromInngestEvent } = await import(
      "../../apps/main/src/lib/db/factories"
    );
    expect(() =>
      tenantContextFromInngestEvent({
        id: "ev1",
        name: "some.event",
        data: { tenant_id: { id: "t1" } as unknown as string },
      }),
    ).toThrow(/tenant_id is missing or not a string/i);
  });

  it("throws when event.data.tenant_id is a number", async () => {
    const { tenantContextFromInngestEvent } = await import(
      "../../apps/main/src/lib/db/factories"
    );
    expect(() =>
      tenantContextFromInngestEvent({
        id: "ev1",
        name: "some.event",
        data: { tenant_id: 12345 as unknown as string },
      }),
    ).toThrow(/tenant_id is missing or not a string/i);
  });

  it("returns context with the supplied tenant_id when valid (sanity)", async () => {
    const { tenantContextFromInngestEvent } = await import(
      "../../apps/main/src/lib/db/factories"
    );
    const ctx = tenantContextFromInngestEvent({
      id: "ev1",
      name: "rag.submission_needs_extraction",
      data: { tenant_id: "valid-uuid" },
    });
    expect(ctx.tenant_id).toBe("valid-uuid");
    expect(ctx.source.kind).toBe("inngest_job");
  });
});

// ---------------------------------------------------------------------------
// tenantContextFromStripeEvent — webhook path
// ---------------------------------------------------------------------------

describe("tenantContextFromStripeEvent — adversarial inputs", () => {
  function mockServiceRoleClientReturning(
    connectTenantId: string | null,
    customerTenantId: string | null,
  ) {
    vi.doMock("../../apps/main/src/lib/db/service-role-client", () => ({
      createServiceRoleClient: () => ({
        from: (table: string) => ({
          select: () => ({
            eq: (col: string) => ({
              maybeSingle: async () => {
                if (table !== "tenants") return { data: null };
                if (col === "stripe_connect_account_id" && connectTenantId) {
                  return { data: { id: connectTenantId } };
                }
                if (col === "stripe_customer_id" && customerTenantId) {
                  return { data: { id: customerTenantId } };
                }
                return { data: null };
              },
            }),
          }),
        }),
      }),
    }));
    vi.doMock("@/lib/audit/write", () => ({
      writeAuditLog: async () => undefined,
    }));
  }

  it("throws WebhookContextNotFoundError when event has no account or customer", async () => {
    mockServiceRoleClientReturning(null, null);
    const { tenantContextFromStripeEvent, WebhookContextNotFoundError } =
      await import("../../apps/main/src/lib/db/factories");
    await expect(
      tenantContextFromStripeEvent({
        id: "evt_1",
        type: "invoice.paid",
      }),
    ).rejects.toBeInstanceOf(WebhookContextNotFoundError);
  });

  it("throws when stripe_connect_account_id is unknown to the tenants table", async () => {
    mockServiceRoleClientReturning(null, null); // no rows match either lookup
    const { tenantContextFromStripeEvent, WebhookContextNotFoundError } =
      await import("../../apps/main/src/lib/db/factories");
    await expect(
      tenantContextFromStripeEvent({
        id: "evt_2",
        type: "account.updated",
        account: "acct_unknown",
      }),
    ).rejects.toBeInstanceOf(WebhookContextNotFoundError);
  });

  it("throws when stripe_customer_id is unknown to the tenants table", async () => {
    mockServiceRoleClientReturning(null, null);
    const { tenantContextFromStripeEvent, WebhookContextNotFoundError } =
      await import("../../apps/main/src/lib/db/factories");
    await expect(
      tenantContextFromStripeEvent({
        id: "evt_3",
        type: "customer.subscription.updated",
        data: { object: { customer: "cus_unknown" } },
      }),
    ).rejects.toBeInstanceOf(WebhookContextNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// tenantContextFromResendEvent — webhook path
// ---------------------------------------------------------------------------

describe("tenantContextFromResendEvent — adversarial inputs", () => {
  it("throws when event.data.email_id is missing", async () => {
    vi.doMock("../../apps/main/src/lib/db/service-role-client", () => ({
      createServiceRoleClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null }) }),
          }),
        }),
      }),
    }));
    vi.doMock("@/lib/audit/write", () => ({ writeAuditLog: async () => undefined }));
    const { tenantContextFromResendEvent, WebhookContextNotFoundError } =
      await import("../../apps/main/src/lib/db/factories");
    await expect(
      tenantContextFromResendEvent({
        id: "evt_resend_1",
        type: "email.bounced",
        data: {},
      }),
    ).rejects.toBeInstanceOf(WebhookContextNotFoundError);
  });

  it("throws when the email_id is not present in email_log", async () => {
    vi.doMock("../../apps/main/src/lib/db/service-role-client", () => ({
      createServiceRoleClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null }) }),
          }),
        }),
      }),
    }));
    vi.doMock("@/lib/audit/write", () => ({ writeAuditLog: async () => undefined }));
    const { tenantContextFromResendEvent, WebhookContextNotFoundError } =
      await import("../../apps/main/src/lib/db/factories");
    await expect(
      tenantContextFromResendEvent({
        id: "evt_resend_2",
        type: "email.complained",
        data: { email_id: "msg_unknown" },
      }),
    ).rejects.toBeInstanceOf(WebhookContextNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// tenantContextForPlatformAdmin — superseded by withPlatformAdminAudit,
// kept as a throwing stub to flag callers still on the old API
// ---------------------------------------------------------------------------

describe("tenantContextForPlatformAdmin — current state", () => {
  it("throws to surface any caller still on the superseded API", async () => {
    const { tenantContextForPlatformAdmin } = await import(
      "../../apps/main/src/lib/db/factories"
    );
    await expect(
      tenantContextForPlatformAdmin(
        { user_id: "admin-1" },
        "target-tenant-uuid",
        "investigation: ticket-123",
      ),
    ).rejects.toThrow(/superseded by withPlatformAdminAudit/i);
  });
});
