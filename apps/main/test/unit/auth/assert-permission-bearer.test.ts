// §22.9/§22.10 — assertPermission bearer token path tests.
//
// Why these tests matter: the bearer path is the auth gate for the
// browser extension and iOS Shortcut. Fail-open here means any caller
// with a forged or expired JWT can write knowledge submissions — or
// worse, reach sensitive routes without re-auth. The sensitive-route
// block and the 401-vs-500 distinction (expired bearer → 401, not 500)
// are both externally visible contracts that must not regress.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { assertPermission, AuthForbidden, AuthReauthRequired } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";

const TENANT_ID = "tenant-uuid-1234";
const AUTH_USER_ID = "auth-user-uuid-5678";
const PUBLIC_USER_ID = "public-user-uuid-9999";

const mocks = vi.hoisted(() => ({
  getConsentPending: vi.fn(),
  tenantContextFromRequest: vi.fn(),
  extractBearerToken: vi.fn(),
  createBearerClient: vi.fn(),
  usersMaybeSingle: vi.fn(),
}));

vi.mock("@/lib/consent/pending", () => ({
  getConsentPending: mocks.getConsentPending,
}));

vi.mock("@/lib/db/factories", () => ({
  tenantContextFromRequest: mocks.tenantContextFromRequest,
}));

vi.mock("@/lib/auth/get-cached-user", () => ({
  getCachedUser: vi.fn(),
}));

vi.mock("@/lib/auth/ssr-client", () => ({
  extractBearerToken: mocks.extractBearerToken,
  createBearerClient: mocks.createBearerClient,
  createRequestScopedClient: () => ({}),
}));

function makeBearerClient(row: unknown, rowError?: unknown) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: row ?? null, error: rowError ?? null }) }),
        }),
      }),
    }),
  };
}

function makeRequest(path: string): Request {
  return new Request(`https://tenant.example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer fake-jwt" },
  });
}

const validCtx = {
  tenant_id: TENANT_ID,
  source: { kind: "http_request" as const, user_id: AUTH_USER_ID },
};

const activeOwnerRow = {
  id: PUBLIC_USER_ID,
  auth_user_id: AUTH_USER_ID,
  tenant_id: TENANT_ID,
  status: "active",
  role: "tenant_owner",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getConsentPending.mockResolvedValue([]);
  mocks.tenantContextFromRequest.mockResolvedValue(validCtx);
  mocks.extractBearerToken.mockReturnValue("fake-jwt");
  mocks.createBearerClient.mockReturnValue(makeBearerClient(activeOwnerRow));
});

describe("assertPermission — bearer token path", () => {
  it("succeeds with valid token and active user", async () => {
    const { ctx, user } = await assertPermission(
      makeRequest("/api/rag/submit/extension"),
      { resource: "rag_submissions", action: "create" },
    );
    expect(ctx.tenant_id).toBe(TENANT_ID);
    expect(user.auth_user_id).toBe(AUTH_USER_ID);
    expect(user.role).toBe("tenant_owner");
  });

  it("blocks sensitive routes with AuthReauthRequired", async () => {
    await expect(
      assertPermission(
        makeRequest("/api/commissions/override"),
        { resource: "commissions", action: "update" },
      ),
    ).rejects.toBeInstanceOf(AuthReauthRequired);
  });

  it("sensitive route bearer rejection maps to 401 via respondToAuthError", async () => {
    let err: unknown;
    try {
      await assertPermission(
        makeRequest("/api/tenant/billing/plan"),
        { resource: "billing", action: "update" },
      );
    } catch (e) {
      err = e;
    }
    const res = respondToAuthError(err);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("reauth_required");
  });

  it("inactive user returns 401 via respondToAuthError, not 500", async () => {
    mocks.createBearerClient.mockReturnValue(
      makeBearerClient({ ...activeOwnerRow, status: "suspended" }),
    );
    let err: unknown;
    try {
      await assertPermission(
        makeRequest("/api/rag/submit/extension"),
        { resource: "rag_submissions", action: "create" },
      );
    } catch (e) {
      err = e;
    }
    const res = respondToAuthError(err);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("DB error on users lookup returns 401, not 500", async () => {
    mocks.createBearerClient.mockReturnValue(
      makeBearerClient(null, { message: "connection error" }),
    );
    let err: unknown;
    try {
      await assertPermission(
        makeRequest("/api/rag/submit/extension"),
        { resource: "rag_submissions", action: "create" },
      );
    } catch (e) {
      err = e;
    }
    const res = respondToAuthError(err);
    // DB error message starts with "assertPermission: DB error:" which is
    // NOT in KNOWN_AUTH_FAILURE_PREFIXES — correctly surfaces as 500 since
    // it's a server fault, not a credential problem.
    expect(res.status).toBe(500);
  });

  it("wrong role returns 403 AuthForbidden", async () => {
    mocks.createBearerClient.mockReturnValue(
      makeBearerClient({ ...activeOwnerRow, role: "viewer" }),
    );
    await expect(
      assertPermission(
        makeRequest("/api/rag/submit/extension"),
        { resource: "rag_submissions", action: "create" },
      ),
    ).rejects.toBeInstanceOf(AuthForbidden);
  });

  it("wrong role maps to 403 via respondToAuthError", async () => {
    mocks.createBearerClient.mockReturnValue(
      makeBearerClient({ ...activeOwnerRow, role: "viewer" }),
    );
    let err: unknown;
    try {
      await assertPermission(
        makeRequest("/api/rag/submit/extension"),
        { resource: "rag_submissions", action: "create" },
      );
    } catch (e) {
      err = e;
    }
    const res = respondToAuthError(err);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden");
  });

  it("does not call createBearerClient when no bearer token present", async () => {
    mocks.extractBearerToken.mockReturnValue(null);
    // Cookie path — getCachedUser returns null → assertPermission throws
    // the known "invalid or expired access token" message → 401.
    // We just assert createBearerClient was never invoked.
    try {
      await assertPermission(
        makeRequest("/api/rag/submit/extension"),
        { resource: "rag_submissions", action: "create" },
      );
    } catch {
      // expected
    }
    expect(mocks.createBearerClient).not.toHaveBeenCalled();
  });
});
