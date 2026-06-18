// Unit tests for apps/main/src/lib/auth/test-bypass.ts
//
// Security-critical: tryTestBypass must be provably inert in prod.
// Four locks — NODE_ENV, VERCEL_ENV, bypass token presence, and
// token match — must each independently block bypass activation.
// A mutant that removes any one lock must fail a test here.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tryTestBypass } from "@/lib/auth/test-bypass";

const BYPASS_TOKEN = "secret-bypass-token";
const AUTH_USER_ID = "auth-user-1";
const TENANT_ID = "tenant-1";

function makeReq(token?: string): Request {
  return new Request("https://app.example.com/api/test", {
    headers: token
      ? { authorization: `Bearer ${token}` }
      : {},
  });
}

// process.env.NODE_ENV is typed read-only in @types/node 22+. Cast to
// write it — the established pattern in this repo (see proxy-unit.test.ts).
const env = process.env as Record<string, string | undefined>;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {
    NODE_ENV: env.NODE_ENV,
    VERCEL_ENV: env.VERCEL_ENV,
    TEST_AUTH_BYPASS_TOKEN: env.TEST_AUTH_BYPASS_TOKEN,
    TEST_AUTH_BYPASS_USER_ID: env.TEST_AUTH_BYPASS_USER_ID,
    TEST_AUTH_BYPASS_TENANT_ID: env.TEST_AUTH_BYPASS_TENANT_ID,
  };
  // Default to a valid test-env setup; individual tests override as needed.
  env.NODE_ENV = "test";
  delete env.VERCEL_ENV;
  env.TEST_AUTH_BYPASS_TOKEN = BYPASS_TOKEN;
  env.TEST_AUTH_BYPASS_USER_ID = AUTH_USER_ID;
  env.TEST_AUTH_BYPASS_TENANT_ID = TENANT_ID;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
});

describe("tryTestBypass — production locks", () => {
  it("returns null when NODE_ENV is 'production' (lock 1)", () => {
    env.NODE_ENV = "production";
    expect(tryTestBypass(makeReq(BYPASS_TOKEN))).toBeNull();
  });

  it("returns null when VERCEL_ENV is 'production' even with non-prod NODE_ENV (lock 2 — belt-and-suspenders)", () => {
    // D-091 Finding 7: middleware bypass had this check; assertPermission path was missing it.
    // Both guards must independently block.
    env.NODE_ENV = "test";
    env.VERCEL_ENV = "production";
    expect(tryTestBypass(makeReq(BYPASS_TOKEN))).toBeNull();
  });
});

describe("tryTestBypass — env-var locks", () => {
  it("returns null when TEST_AUTH_BYPASS_TOKEN is not set (lock 3)", () => {
    delete process.env.TEST_AUTH_BYPASS_TOKEN;
    expect(tryTestBypass(makeReq(BYPASS_TOKEN))).toBeNull();
  });

  it("returns null when TEST_AUTH_BYPASS_USER_ID is not set", () => {
    delete process.env.TEST_AUTH_BYPASS_USER_ID;
    expect(tryTestBypass(makeReq(BYPASS_TOKEN))).toBeNull();
  });

  it("returns null when TEST_AUTH_BYPASS_TENANT_ID is not set", () => {
    delete process.env.TEST_AUTH_BYPASS_TENANT_ID;
    expect(tryTestBypass(makeReq(BYPASS_TOKEN))).toBeNull();
  });
});

describe("tryTestBypass — token match locks", () => {
  it("returns null when Authorization header is absent (lock 4 — no header)", () => {
    expect(tryTestBypass(makeReq())).toBeNull();
  });

  it("returns null when token bytes do not match (wrong token)", () => {
    expect(tryTestBypass(makeReq("wrong-token"))).toBeNull();
  });

  it("returns null when token byte length differs (timing leak guard)", () => {
    // A token with the right prefix but extra bytes must fail.
    expect(tryTestBypass(makeReq(BYPASS_TOKEN + "-extra"))).toBeNull();
  });

  it("strips 'Bearer ' prefix before comparing — plain token without prefix also works", () => {
    // The function does: header.startsWith("Bearer ") ? slice : header
    // This test confirms a header WITHOUT the prefix also matches (the slice
    // path is NOT triggered — the comparison uses the raw header string).
    // Intentional: the source maps both forms to the same comparison.
    const req = new Request("https://app.example.com/", {
      headers: { authorization: BYPASS_TOKEN },
    });
    const result = tryTestBypass(req);
    // Without "Bearer " prefix the raw token IS the header value — it matches.
    expect(result).not.toBeNull();
  });
});

describe("tryTestBypass — happy path", () => {
  it("returns auth_user_id and tenant_id when all 4 locks pass", () => {
    const result = tryTestBypass(makeReq(BYPASS_TOKEN));
    expect(result).not.toBeNull();
    expect(result!.auth_user_id).toBe(AUTH_USER_ID);
    expect(result!.tenant_id).toBe(TENANT_ID);
  });

  it("works in 'development' environment (standard local dev)", () => {
    env.NODE_ENV = "development";
    expect(tryTestBypass(makeReq(BYPASS_TOKEN))).not.toBeNull();
  });
});
