// Unit tests for verifyServiceJwt — §8.3 fail-closed contract
//
// Tests all 7 outcomes: 6 explicit failure modes + 1 success path.
// Each test asserts both the status code and the error code string so that
// a future refactor can't accidentally swap two 401 codes.
//
// Design notes:
//   - beforeAll generates one keypair for the entire suite. The module-level
//     keyCache in verify-service-jwt.ts is populated once (during test 4 /
//     tampered, where getPublicKey runs then jwtVerify rejects the bad sig).
//     Tests 5+ reuse the cached key correctly. Using beforeEach would rotate
//     the keypair every test, causing the cache to hold the wrong key.
//   - vi.doMock (not vi.mock) is used for inline mocks. vi.mock is hoisted
//     to the top of the file; doMock is not, so each test controls exactly
//     which mocks are active for its fresh import.

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { SignJWT, generateKeyPair, exportSPKI } from "jose";
import { randomUUID } from "node:crypto";

import { withServiceAuth } from "@/lib/auth/with-service-auth";

// ── Key setup (once per suite) ────────────────────────────────────────────────

let privateKey: CryptoKey;
let publicKeyPem: string;
const KEY_ID = "test-v1";

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicKeyPem = await exportSPKI(pair.publicKey);
});

// ── JWT builder ──────────────────────────────────────────────────────────────

type ClaimsOverride = {
  tenant_id?: string | null;
  scope?: string;
  kid?: string;
  exp?: number;
  iat?: number;
  jti?: string | null;
};

async function makeToken(overrides: ClaimsOverride = {}) {
  const now = Math.floor(Date.now() / 1000);
  const jti = overrides.jti !== undefined ? overrides.jti : randomUUID();

  let builder = new SignJWT({
    tenant_id: overrides.tenant_id !== undefined ? overrides.tenant_id : "tenant-uuid-placeholder",
    scope: overrides.scope ?? "read",
    ...(jti !== null ? { jti } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: overrides.kid ?? KEY_ID })
    .setIssuedAt(overrides.iat ?? now)
    .setExpirationTime(overrides.exp ?? now + 300);

  return builder.sign(privateKey);
}

// ── Mock helpers ─────────────────────────────────────────────────────────────

function makeReq(token?: string): Request {
  return new Request("http://rag.test/api/retrieve", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function callHandler(req: Request): Promise<Response> {
  const handler = withServiceAuth(async (_req, _ctx) =>
    Response.json({ ok: true }),
  );
  return handler(req, { params: Promise.resolve({}) });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("verifyServiceJwt — fail-closed contract", () => {
  beforeEach(() => {
    vi.stubEnv("SERVICE_JWT_PUBLIC_KEY", publicKeyPem.replace(/\n/g, "\\n"));
    vi.stubEnv("SERVICE_JWT_ACCEPTED_KEY_IDS", KEY_ID);
    vi.stubEnv("SUPABASE_RAG_URL", "http://supabase.test");
    vi.stubEnv("SUPABASE_RAG_SERVICE_ROLE_KEY", "test-service-key");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  });

  // ── 1. missing_token ────────────────────────────────────────────────────
  it("returns 401 missing_token when Authorization header is absent", async () => {
    const res = await callHandler(makeReq());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "missing_token" });
  });

  it("returns 401 missing_token when Bearer token is empty string", async () => {
    const req = new Request("http://rag.test/api/retrieve", {
      method: "POST",
      headers: { authorization: "Bearer " },
    });
    const res = await callHandler(req);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "missing_token" });
  });

  // ── 2. signature_invalid ────────────────────────────────────────────────
  it("returns 401 signature_invalid when kid is not in accepted list", async () => {
    const token = await makeToken({ kid: "unknown-key" });
    const res = await callHandler(makeReq(token));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "signature_invalid" });
  });

  it("returns 401 signature_invalid when token is tampered", async () => {
    const token = await makeToken();
    const tampered = token.slice(0, -10) + "tampered!!";
    const res = await callHandler(makeReq(tampered));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "signature_invalid" });
  });

  // ── 3. expired ──────────────────────────────────────────────────────────
  it("returns 401 expired when iat is older than 5 minutes", async () => {
    const staleIat = Math.floor(Date.now() / 1000) - 310;
    const token = await makeToken({ iat: staleIat });
    const res = await callHandler(makeReq(token));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "expired" });
  });

  // ── 4. redis_unreachable ────────────────────────────────────────────────
  // vi.doMock (not vi.mock) so the mock is NOT hoisted and only applies to
  // the dynamic import below, not to the top-level import used in tests 1-5.
  it("returns 503 redis_unreachable when Redis connection fails", async () => {
    vi.resetModules();
    vi.doMock("ioredis", () => ({
      default: class MockRedis {
        set() { return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:19999")); }
      },
      Redis: class MockRedis {
        set() { return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:19999")); }
      },
    }));

    const { withServiceAuth: freshWrapper } = await import(
      "@/lib/auth/with-service-auth"
    );

    const token = await makeToken();
    const req = makeReq(token);
    const handler = freshWrapper(async () => Response.json({ ok: true }));

    const res = await handler(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "redis_unreachable" });
  });

  // ── 5. tenant_unknown ───────────────────────────────────────────────────
  it("returns 403 tenant_unknown when tenant is not in shadow table", async () => {
    vi.resetModules();
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      }),
    }));
    vi.doMock("@/lib/redis/client", () => ({
      getRedis: () => ({ set: async () => "OK" }),
    }));

    const { withServiceAuth: freshWrapper } = await import(
      "@/lib/auth/with-service-auth"
    );

    const token = await makeToken({ tenant_id: "unknown-tenant" });
    const handler = freshWrapper(async () => Response.json({ ok: true }));
    const res = await handler(makeReq(token), { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "tenant_unknown" });
  });

  // ── 6. tenant_inactive ──────────────────────────────────────────────────
  it("returns 403 tenant_inactive when shadow status is not active", async () => {
    vi.resetModules();
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { tenant_id: "t1", status: "suspended" },
                error: null,
              }),
            }),
          }),
        }),
      }),
    }));
    vi.doMock("@/lib/redis/client", () => ({
      getRedis: () => ({ set: async () => "OK" }),
    }));

    const { withServiceAuth: freshWrapper } = await import(
      "@/lib/auth/with-service-auth"
    );

    const token = await makeToken({ tenant_id: "suspended-tenant" });
    const handler = freshWrapper(async () => Response.json({ ok: true }));
    const res = await handler(makeReq(token), { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "tenant_inactive" });
  });

  // ── 7. success path ──────────────────────────────────────────────────────
  it("calls handler and returns its response when all checks pass", async () => {
    vi.resetModules();
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { tenant_id: "active-tenant", status: "active" },
                error: null,
              }),
            }),
          }),
        }),
      }),
    }));
    vi.doMock("@/lib/redis/client", () => ({
      getRedis: () => ({ set: async () => "OK" }),
    }));

    const { withServiceAuth: freshWrapper } = await import(
      "@/lib/auth/with-service-auth"
    );

    const token = await makeToken({ tenant_id: "active-tenant" });
    const handler = freshWrapper(async (_req, ctx) =>
      Response.json({ reached: true, tenant_id: ctx.tenant_id }),
    );
    const res = await handler(makeReq(token), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reached: true, tenant_id: "active-tenant" });
  });
});
