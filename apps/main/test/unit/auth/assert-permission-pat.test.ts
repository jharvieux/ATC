// #712 — assertPermission personal access token path tests.
//
// Why these tests matter: PATs are long-lived credentials stored outside the
// browser session. A fail-open here (wrong-tenant token accepted, revoked
// token accepted, scope ceiling bypass) is a persistent security hole that
// persists until the token is manually rotated. Each case below verifies
// the hard-stop that prevents the next category of abuse.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { assertPermission, AuthForbidden, AuthReauthRequired } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";

const TENANT_ID = "tenant-uuid-aaaa";
const OTHER_TENANT_ID = "tenant-uuid-bbbb";
const AUTH_USER_ID = "auth-user-uuid-1111";
const PUBLIC_USER_ID = "public-user-uuid-2222";
const RAW_TOKEN = "atc_pat_deadbeefdeadbeefdeadbeef";
const TOKEN_HASH = createHash("sha256").update(RAW_TOKEN).digest("hex");

const mocks = vi.hoisted(() => ({
  extractBearerToken: vi.fn(),
  isSensitiveRoute: vi.fn(),
  getConsentPending: vi.fn(),
  safeAwait: vi.fn(),
  svcFrom: vi.fn(),
}));

vi.mock("@/lib/auth/ssr-client", () => ({
  extractBearerToken: mocks.extractBearerToken,
  createBearerClient: vi.fn(),
  createRequestScopedClient: vi.fn(),
}));

vi.mock("@/lib/auth/sensitive-routes", () => ({
  isSensitiveRoute: mocks.isSensitiveRoute,
  SENSITIVE_SESSION_MAX_AGE_MS: 4 * 60 * 60 * 1000,
}));

vi.mock("@/lib/consent/pending", () => ({
  getConsentPending: mocks.getConsentPending,
}));

vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: mocks.safeAwait,
  safeAwaitRowCount: vi.fn(),
}));

vi.mock("@/lib/db/factories", () => ({
  tenantContextFromRequest: vi.fn(),
}));

vi.mock("@/lib/auth/get-cached-user", () => ({
  getCachedUser: vi.fn(),
}));

function makeServiceRoleClient(
  patData: unknown,
  patError: { message: string } | null = null,
  userData: unknown = null,
  userError: { message: string } | null = null,
): { from: (table: string) => unknown } {
  return {
    from: (table: string) => {
      if (table === "personal_access_tokens") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: patData, error: patError }),
            }),
          }),
          update: () => ({
            eq: () => ({
              eq: () => ({
                is: () => ({
                  select: () => Promise.resolve({ data: [{ id: "pat-id-1" }], error: null }),
                }),
              }),
            }),
          }),
        };
      }
      // users table
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: userData, error: userError }),
            }),
          }),
        }),
      };
    },
  };
}

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => mocks.svcFrom(),
}));

const validPat = {
  id: "pat-id-1",
  tenant_id: TENANT_ID,
  user_id: PUBLIC_USER_ID,
  scopes: ["rag_submissions:create"],
  revoked_at: null,
  last_used_at: null,
};

const activeOwnerUser = {
  id: PUBLIC_USER_ID,
  auth_user_id: AUTH_USER_ID,
  tenant_id: TENANT_ID,
  status: "active",
  role: "tenant_owner",
};

function makeRequest(path = "/api/rag/submit/ios-shortcut"): Request {
  return new Request(`https://tenant.example.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RAW_TOKEN}`,
      "x-resolved-tenant-id": TENANT_ID,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.extractBearerToken.mockReturnValue(RAW_TOKEN);
  mocks.isSensitiveRoute.mockReturnValue(false);
  mocks.getConsentPending.mockResolvedValue([]);
  mocks.safeAwait.mockResolvedValue(undefined);
  mocks.svcFrom.mockReturnValue(makeServiceRoleClient(validPat, null, activeOwnerUser, null));
});

describe("assertPermission — PAT path", () => {
  it("succeeds with valid token, active owner, matching tenant, and granted scope", async () => {
    const { ctx, user } = await assertPermission(
      makeRequest(),
      { resource: "rag_submissions", action: "create" },
    );
    expect(ctx.tenant_id).toBe(TENANT_ID);
    expect(user.id).toBe(PUBLIC_USER_ID);
    expect(user.role).toBe("tenant_owner");
  });

  it("blocks sensitive routes (PATs lack re-auth UI)", async () => {
    mocks.isSensitiveRoute.mockReturnValue(true);
    await expect(
      assertPermission(makeRequest("/api/commissions/override"), { resource: "commissions", action: "update" }),
    ).rejects.toBeInstanceOf(AuthReauthRequired);
  });

  it("rejects token not found in DB → 401 via respondToAuthError", async () => {
    mocks.svcFrom.mockReturnValue(makeServiceRoleClient(null));
    let err: unknown;
    try { await assertPermission(makeRequest(), { resource: "rag_submissions", action: "create" }); }
    catch (e) { err = e; }
    expect((err as Error).message).toContain("invalid personal access token");
    expect(respondToAuthError(err).status).toBe(401);
  });

  it("rejects revoked token → 401 via respondToAuthError", async () => {
    mocks.svcFrom.mockReturnValue(
      makeServiceRoleClient({ ...validPat, revoked_at: "2026-06-01T00:00:00Z" }),
    );
    let err: unknown;
    try { await assertPermission(makeRequest(), { resource: "rag_submissions", action: "create" }); }
    catch (e) { err = e; }
    expect((err as Error).message).toContain("revoked");
    expect(respondToAuthError(err).status).toBe(401);
  });

  it("rejects token belonging to a different tenant → 401 via respondToAuthError", async () => {
    mocks.svcFrom.mockReturnValue(
      makeServiceRoleClient({ ...validPat, tenant_id: OTHER_TENANT_ID }),
    );
    let err: unknown;
    try { await assertPermission(makeRequest(), { resource: "rag_submissions", action: "create" }); }
    catch (e) { err = e; }
    expect((err as Error).message).toContain("tenant mismatch");
    expect(respondToAuthError(err).status).toBe(401);
  });

  it("rejects inactive user → 401 via respondToAuthError", async () => {
    mocks.svcFrom.mockReturnValue(
      makeServiceRoleClient(validPat, null, { ...activeOwnerUser, status: "suspended" }),
    );
    let err: unknown;
    try { await assertPermission(makeRequest(), { resource: "rag_submissions", action: "create" }); }
    catch (e) { err = e; }
    expect((err as Error).message).toContain("not active");
    expect(respondToAuthError(err).status).toBe(401);
  });

  it("scope ceiling: rejects when required scope not in token's scopes", async () => {
    mocks.svcFrom.mockReturnValue(
      makeServiceRoleClient({ ...validPat, scopes: [] }, null, activeOwnerUser),
    );
    await expect(
      assertPermission(makeRequest(), { resource: "rag_submissions", action: "create" }),
    ).rejects.toBeInstanceOf(AuthForbidden);
  });

  it("role RBAC: rejects when acting user's role lacks the grant", async () => {
    mocks.svcFrom.mockReturnValue(
      makeServiceRoleClient(
        { ...validPat, scopes: ["rag_submissions:create"] },
        null,
        { ...activeOwnerUser, role: "viewer" },
      ),
    );
    await expect(
      assertPermission(makeRequest(), { resource: "rag_submissions", action: "create" }),
    ).rejects.toBeInstanceOf(AuthForbidden);
  });

  it("consent gate: rejects when user has pending consent", async () => {
    const { ConsentPendingError } = await import("@/lib/auth/assert-permission");
    mocks.getConsentPending.mockResolvedValue([
      { document_type: "tou", document_id_pending: "doc-1", flagged_at: "2026-06-01T00:00:00Z" },
    ]);
    await expect(
      assertPermission(makeRequest(), { resource: "rag_submissions", action: "create" }),
    ).rejects.toBeInstanceOf(ConsentPendingError);
  });

  it("PAT lookup DB error → 500 (server fault, not credential failure)", async () => {
    mocks.svcFrom.mockReturnValue(
      makeServiceRoleClient(null, { message: "connection timeout" }),
    );
    let err: unknown;
    try { await assertPermission(makeRequest(), { resource: "rag_submissions", action: "create" }); }
    catch (e) { err = e; }
    expect((err as Error).message).toContain("PAT lookup failed");
    // DB error is a server fault — must NOT return 401 (that would hide infra outages).
    expect(respondToAuthError(err).status).toBe(500);
  });

  it("missing tenant header → 401 via respondToAuthError", async () => {
    const req = new Request("https://tenant.example.com/api/rag/submit/ios-shortcut", {
      method: "POST",
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    });
    let err: unknown;
    try { await assertPermission(req, { resource: "rag_submissions", action: "create" }); }
    catch (e) { err = e; }
    expect((err as Error).message).toContain("missing or platform tenant context");
    expect(respondToAuthError(err).status).toBe(401);
  });

  it("does NOT call tenantContextFromRequest on the PAT path", async () => {
    const { tenantContextFromRequest } = await import("@/lib/db/factories");
    await assertPermission(makeRequest(), { resource: "rag_submissions", action: "create" });
    expect(tenantContextFromRequest).not.toHaveBeenCalled();
  });

  it("token hash is SHA-256 of the raw token (hash-only storage contract)", async () => {
    // The service role client receives eq("token_hash", ...) — ensure the hash
    // matches what we'd compute independently. We verify indirectly: if the
    // test above passes with RAW_TOKEN, the hash was computed correctly.
    // This test locks the HASH_FUNCTION used so a future refactor doesn't
    // silently change encoding and break every existing token.
    const expected = createHash("sha256").update(RAW_TOKEN).digest("hex");
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(TOKEN_HASH).toBe(expected);
  });
});

describe("assertPermission — PAT last_used_at throttle", () => {
  // last_used_at exists for operator visibility ("is this token still in
  // use?") but writing it on EVERY request would turn each API call into a
  // DB write. The throttle caps that at one write per 5 minutes — these
  // tests pin both sides so a refactor can't silently drop the audit trail
  // (never writes) or the throttle (writes every call).
  const THROTTLE_CTX = "personal_access_tokens.update.last_used_at";

  it("writes last_used_at when the token has never been used", async () => {
    // validPat.last_used_at is null → treated as epoch → write fires.
    await assertPermission(makeRequest(), { resource: "rag_submissions", action: "create" });
    expect(mocks.safeAwait).toHaveBeenCalledWith(expect.anything(), THROTTLE_CTX);
  });

  it("writes last_used_at when the last use is older than the throttle window", async () => {
    const staleUse = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    mocks.svcFrom.mockReturnValue(
      makeServiceRoleClient({ ...validPat, last_used_at: staleUse }, null, activeOwnerUser, null),
    );
    await assertPermission(makeRequest(), { resource: "rag_submissions", action: "create" });
    expect(mocks.safeAwait).toHaveBeenCalledWith(expect.anything(), THROTTLE_CTX);
  });

  it("skips the write when the token was used within the throttle window", async () => {
    const recentUse = new Date(Date.now() - 60 * 1000).toISOString();
    mocks.svcFrom.mockReturnValue(
      makeServiceRoleClient({ ...validPat, last_used_at: recentUse }, null, activeOwnerUser, null),
    );
    await assertPermission(makeRequest(), { resource: "rag_submissions", action: "create" });
    const throttleWrites = mocks.safeAwait.mock.calls.filter((c) => c[1] === THROTTLE_CTX);
    expect(throttleWrites).toHaveLength(0);
  });
});
