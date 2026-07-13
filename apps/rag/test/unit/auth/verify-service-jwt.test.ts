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
import { SERVICE_JWT_AUDIENCE, SERVICE_JWT_ISSUER } from "@atc/contracts";

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
  iss?: string;
  aud?: string;
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

  // iss/aud default to ABSENT so existing tests exercise the tolerant rollout
  // path; individual tests opt in to set/mismatch them (#1773).
  if (overrides.iss !== undefined) builder = builder.setIssuer(overrides.iss);
  if (overrides.aud !== undefined) builder = builder.setAudience(overrides.aud);

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
    vi.stubEnv("SERVICE_JWT_KEY_ID_CURRENT", KEY_ID);
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

  // ── 2.5 iss/aud defense-in-depth (#1773) ─────────────────────────────────
  // A PRESENT claim must match; these throw at step 2.5 (after signature,
  // before redis/tenant) so they need no redis/supabase mocks.
  it("returns 401 signature_invalid when iss is present but wrong", async () => {
    const token = await makeToken({ iss: "evil-issuer", aud: SERVICE_JWT_AUDIENCE });
    const res = await callHandler(makeReq(token));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "signature_invalid" });
  });

  it("returns 401 signature_invalid when aud is present but wrong", async () => {
    const token = await makeToken({ iss: SERVICE_JWT_ISSUER, aud: "some-other-service" });
    const res = await callHandler(makeReq(token));
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

  // ── kid→PEM rotation mapping (Greptile audit #7) ────────────────────────
  it("rejects with signature_invalid when kid is allowlisted but has no mapped PEM", async () => {
    // Set up an allowlist that includes the test kid but DON'T set
    // SERVICE_JWT_KEY_ID_CURRENT to match. The kid passes the allowlist check
    // upstream but fails the kid→PEM mapping in getPublicKey.
    //
    // Use vi.resetModules + dynamic import to force a FRESH keyCache. Without
    // it, the module-level cache from earlier tests still holds the test KEY_ID
    // mapped to the real PEM and the new mapping check never runs.
    vi.stubEnv("SERVICE_JWT_KEY_ID_CURRENT", "different-kid");
    vi.stubEnv("SERVICE_JWT_ACCEPTED_KEY_IDS", `${KEY_ID},different-kid`);

    vi.resetModules();
    const { withServiceAuth: freshWrapper } = await import(
      "@/lib/auth/with-service-auth"
    );

    const token = await makeToken({ kid: KEY_ID });
    const handler = freshWrapper(async () => Response.json({ ok: true }));
    const res = await handler(makeReq(token), { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "signature_invalid" });
  });

  it("routes PREVIOUS kid to SERVICE_JWT_PUBLIC_KEY_PREVIOUS during rotation overlap", async () => {
    // Generate a SECOND keypair representing the previous rotation generation.
    const prevPair = await generateKeyPair("RS256");
    const prevPem = await exportSPKI(prevPair.publicKey);
    const PREV_KID = "test-v0";

    vi.stubEnv("SERVICE_JWT_PUBLIC_KEY_PREVIOUS", prevPem.replace(/\n/g, "\\n"));
    vi.stubEnv("SERVICE_JWT_KEY_ID_PREVIOUS", PREV_KID);
    vi.stubEnv("SERVICE_JWT_ACCEPTED_KEY_IDS", `${KEY_ID},${PREV_KID}`);

    vi.resetModules();
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { tenant_id: "rotating-tenant", status: "active" },
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

    // Sign a token with the PREVIOUS private key + the PREVIOUS kid header.
    // Pre-fix this would have failed signature_invalid because the verifier
    // used the CURRENT PEM for every kid.
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      tenant_id: "rotating-tenant",
      scope: "read",
      jti: randomUUID(),
    })
      .setProtectedHeader({ alg: "RS256", kid: PREV_KID })
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(prevPair.privateKey);

    const handler = freshWrapper(async () => Response.json({ ok: true }));
    const res = await handler(makeReq(token), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
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

  // ── #1773: correct iss+aud present → success ─────────────────────────────
  it("accepts a token carrying the correct iss and aud", async () => {
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

    const { withServiceAuth: freshWrapper } = await import("@/lib/auth/with-service-auth");

    const token = await makeToken({
      tenant_id: "active-tenant",
      iss: SERVICE_JWT_ISSUER,
      aud: SERVICE_JWT_AUDIENCE,
    });
    const handler = freshWrapper(async () => Response.json({ ok: true }));
    const res = await handler(makeReq(token), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });

  // ── #1773: ROLLOUT INTENT — absent iss/aud is tolerated (not rejected) ────
  // Deliberate transitional behaviour: atc-main (signer) and atc-rag (verifier)
  // are separate Vercel apps that deploy at different times, so short-TTL
  // tokens minted before the signer upgrade can still arrive here. Until the
  // #1773 strict flip, an absent claim is warn-logged and allowed. This test
  // is the executable record of that intent — when the flip lands it MUST be
  // changed to assert 401.
  it("tolerates a token with NO iss/aud during the rollout window", async () => {
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

    const { withServiceAuth: freshWrapper } = await import("@/lib/auth/with-service-auth");

    // makeToken with no iss/aud overrides → both claims absent.
    const token = await makeToken({ tenant_id: "active-tenant" });
    const handler = freshWrapper(async () => Response.json({ ok: true }));
    const res = await handler(makeReq(token), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
  });
});
