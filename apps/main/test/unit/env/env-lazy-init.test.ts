// Tests for env() lazy-init (the billing/onboarding internal_error root cause).
//
// WHY this matters: instrumentation.ts calls verifyEnvAtBoot() in register(),
// but Next bundles that module instance separately from route handler chunks.
// A route whose dependency graph imports env.ts (e.g. priceIdFor → env()) gets
// a DIFFERENT env.ts instance whose _env singleton was never populated. The old
// env() threw "env() called before verifyEnvAtBoot()" in that case, surfacing as
// a bare internal_error on the Set Up Billing screen. env() must instead resolve
// lazily from process.env at request time. These tests fail if env() ever goes
// back to requiring a prior boot call.
//
// Kept in its own file with no module-level env mock so each dynamic import
// re-evaluates env.ts against the process.env we set per test.

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
    CRON_SECRET: "cron-secret",
    INNGEST_SIGNING_KEY: "signkey",
    INNGEST_EVENT_KEY: "eventkey",
    SERVICE_JWT_PRIVATE_KEY: "privkey",
    SERVICE_JWT_KEY_ID_CURRENT: "kid1",
    RAG_SERVICE_URL: "https://rag.test.example.com",
    RAG_WEBHOOK_SECRET: "rag-secret",
    MAIN_APP_ADMIN_API_KEY: "admin-api-key",
    APP_ENCRYPTION_KEY_CURRENT: APP_KEY_B64,
    APP_ENCRYPTION_KEY_ID_CURRENT: "v1",
    INVITATION_TOKEN_HMAC_KEY: HMAC_KEY_B64,
    ANON_COOKIE_SECRET: "test-anon-cookie-secret-32-chars-xx",
    PLATFORM_PEPPER: "test-pepper",
    FORENSICS_ENCRYPTION_KEY_CURRENT: FORENSICS_KEY_B64,
    ANTHROPIC_API_KEY: "sk-ant-test-placeholder",
    MICROSOFT_GRAPH_CLIENT_ID: "ms-test-client-id",
    MICROSOFT_GRAPH_CLIENT_SECRET: "ms-test-client-secret",
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
  vi.resetModules();
});

afterEach(() => {
  process.env = originalEnv;
});

describe("env() lazy-init", () => {
  it("resolves env WITHOUT a prior verifyEnvAtBoot() call — the cross-bundle case", async () => {
    process.env = baseEnv();
    // Import and call env() directly, never invoking verifyEnvAtBoot first.
    // This mirrors a route handler chunk whose env.ts instance never ran boot.
    const { env } = await import("@/lib/env");
    expect(() => env()).not.toThrow();
    expect(env().STRIPE_SECRET_KEY).toBe("sk_test_key");
  });

  it("throws the aggregated validation error (not the cryptic boot message) when a required var is missing", async () => {
    const e = baseEnv();
    delete e.STRIPE_SECRET_KEY;
    process.env = e;
    const { env } = await import("@/lib/env");
    // Must be the real validation message, proving lazy verify ran — not the
    // old "env() called before verifyEnvAtBoot()" stub.
    expect(() => env()).toThrow(/Missing or invalid environment variables/);
    expect(() => env()).not.toThrow(/called before verifyEnvAtBoot/);
  });

  it("returns the same memoized object on repeated calls", async () => {
    process.env = baseEnv();
    const { env } = await import("@/lib/env");
    expect(env()).toBe(env());
  });
});
