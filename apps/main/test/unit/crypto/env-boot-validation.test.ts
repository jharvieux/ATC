// Tests for verifyEnvAtBoot() encryption key validation (§13.5.3 + §26.5a).
// Kept in a separate file so it has no module-level env mock.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const APP_KEY_B64 = Buffer.from("a".repeat(32)).toString("base64");
const FORENSICS_KEY_B64 = Buffer.from("b".repeat(32)).toString("base64");
const HMAC_KEY_B64 = Buffer.from("c".repeat(32)).toString("base64");

let originalEnv: NodeJS.ProcessEnv;

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...originalEnv,
    NODE_ENV: "test",
    PLATFORM_PRIMARY_DOMAIN: "test.example.com",
    PLATFORM_DOMAIN_REGEX: "^([a-z0-9-]+)\\.test\\.example\\.com$",
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    STRIPE_SECRET_KEY: "sk_test_key",
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_key",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_test",
    INNGEST_SIGNING_KEY: "signkey",
    INNGEST_EVENT_KEY: "eventkey",
    SERVICE_JWT_PRIVATE_KEY: "privkey",
    SERVICE_JWT_KEY_ID_CURRENT: "kid1",
    RAG_SERVICE_URL: "https://rag.test.example.com",
    RAG_WEBHOOK_SECRET: "rag-secret",
    APP_ENCRYPTION_KEY_CURRENT: APP_KEY_B64,
    APP_ENCRYPTION_KEY_ID_CURRENT: "v1",
    INVITATION_TOKEN_HMAC_KEY: HMAC_KEY_B64,
    ANON_COOKIE_SECRET: "test-anon-cookie-secret-32-chars-xx",
    PLATFORM_PEPPER: "test-pepper",
    FORENSICS_ENCRYPTION_KEY_CURRENT: FORENSICS_KEY_B64,
    // BP29 §28.5 — ANTHROPIC_API_KEY is required at boot with sk-ant- prefix.
    ANTHROPIC_API_KEY: "sk-ant-test-placeholder",
    // BP29 §28.9 — Microsoft OAuth is enabled by default; tests that don't
    // explicitly disable it need placeholder Graph creds to satisfy the
    // conditional refinement.
    MICROSOFT_GRAPH_CLIENT_ID: "ms-test-client-id",
    MICROSOFT_GRAPH_CLIENT_SECRET: "ms-test-client-secret",
    // BP31 §32.14 — GitHub App config required at boot.
    GITHUB_APP_ID: "111111",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nTEST_PLACEHOLDER\n-----END PRIVATE KEY-----",
    GITHUB_APP_INSTALLATION_ID: "222222",
    GITHUB_REPO_OWNER: "jharvieux",
    GITHUB_REPO_NAME: "ATC",
    ...overrides,
  };
}

beforeEach(() => {
  originalEnv = process.env;
  // env.ts memoizes _env at module scope; reset modules between tests so
  // each call to verifyEnvAtBoot re-parses process.env from scratch.
  vi.resetModules();
});

afterEach(() => {
  process.env = originalEnv;
});

describe("verifyEnvAtBoot — encryption key validation (§13.5.3)", () => {
  it("rejects APP_ENCRYPTION_KEY_CURRENT that decodes to fewer than 32 bytes", async () => {
    const shortKey = Buffer.from("tooshort").toString("base64"); // 8 bytes
    process.env = baseEnv({ APP_ENCRYPTION_KEY_CURRENT: shortKey });
    const { verifyEnvAtBoot } = await import("@/lib/env");
    expect(() => verifyEnvAtBoot()).toThrow(/32 bytes/);
  });

  it("accepts a valid 32-byte base64 key", async () => {
    process.env = baseEnv();
    const { verifyEnvAtBoot } = await import("@/lib/env");
    expect(() => verifyEnvAtBoot()).not.toThrow();
  });
});

describe("verifyEnvAtBoot — forensics key separation (§26.5a)", () => {
  it("rejects when FORENSICS_ENCRYPTION_KEY_CURRENT equals APP_ENCRYPTION_KEY_CURRENT", async () => {
    process.env = baseEnv({
      FORENSICS_ENCRYPTION_KEY_CURRENT: APP_KEY_B64, // same as APP key
    });
    const { verifyEnvAtBoot } = await import("@/lib/env");
    expect(() => verifyEnvAtBoot()).toThrow(/security-violation/);
  });

  it("rejects FORENSICS_ENCRYPTION_KEY_CURRENT shorter than 32 bytes", async () => {
    const shortKey = Buffer.from("tooshort").toString("base64");
    process.env = baseEnv({ FORENSICS_ENCRYPTION_KEY_CURRENT: shortKey });
    const { verifyEnvAtBoot } = await import("@/lib/env");
    expect(() => verifyEnvAtBoot()).toThrow(/FORENSICS_ENCRYPTION_KEY_CURRENT: must decode/);
  });

  it("accepts distinct 32-byte forensics + app keys", async () => {
    process.env = baseEnv(); // already has distinct keys
    const { verifyEnvAtBoot } = await import("@/lib/env");
    expect(() => verifyEnvAtBoot()).not.toThrow();
  });
});
