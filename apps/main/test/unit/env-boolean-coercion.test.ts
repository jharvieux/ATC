// Tests for envBoolean() in apps/main/src/lib/env.ts.
//
// z.coerce.boolean() treats the string 'false' as truthy (JS gotcha:
// Boolean('false') === true), which silently flipped feature flags and
// kill switches set to 'false' in env. envBoolean() parses common boolean
// spellings explicitly. These tests pin that behavior so a future refactor
// can't re-introduce the bug.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Buffer } from "node:buffer";

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

// Pick MAINTENANCE_MODE as the canary: it defaults to false, so 'false'
// vs default(false) is observably distinct from 'true'. SIGNUP_ENABLED is
// the inverse canary: defaults to true.

describe("envBoolean() — false-spellings produce false", () => {
  it.each(["false", "FALSE", "False", " false ", "0", "no", "NO", "off", "OFF", ""])(
    "MAINTENANCE_MODE=%j is false",
    async (val) => {
      process.env = baseEnv({ MAINTENANCE_MODE: val });
      const { verifyEnvAtBoot } = await import("@/lib/env");
      expect(verifyEnvAtBoot().MAINTENANCE_MODE).toBe(false);
    }
  );
});

describe("envBoolean() — true-spellings produce true", () => {
  it.each(["true", "TRUE", "True", " true ", "1", "yes", "YES", "on", "ON"])(
    "MAINTENANCE_MODE=%j is true",
    async (val) => {
      process.env = baseEnv({ MAINTENANCE_MODE: val });
      const { verifyEnvAtBoot } = await import("@/lib/env");
      expect(verifyEnvAtBoot().MAINTENANCE_MODE).toBe(true);
    }
  );
});

describe("envBoolean() — defaults apply when unset", () => {
  it("MAINTENANCE_MODE unset → false (default)", async () => {
    const env = baseEnv();
    delete env.MAINTENANCE_MODE;
    process.env = env;
    const { verifyEnvAtBoot } = await import("@/lib/env");
    expect(verifyEnvAtBoot().MAINTENANCE_MODE).toBe(false);
  });

  it("SIGNUP_ENABLED unset → true (default)", async () => {
    const env = baseEnv();
    delete env.SIGNUP_ENABLED;
    process.env = env;
    const { verifyEnvAtBoot } = await import("@/lib/env");
    expect(verifyEnvAtBoot().SIGNUP_ENABLED).toBe(true);
  });
});

describe("envBoolean() — unrecognized strings fail validation", () => {
  it("MAINTENANCE_MODE='maybe' throws at boot", async () => {
    process.env = baseEnv({ MAINTENANCE_MODE: "maybe" });
    const { verifyEnvAtBoot } = await import("@/lib/env");
    expect(() => verifyEnvAtBoot()).toThrow(/MAINTENANCE_MODE/);
  });
});

describe("envBoolean() — OAUTH_MICROSOFT_ENABLED disables Graph requirement", () => {
  it("OAUTH_MICROSOFT_ENABLED='false' allows missing MS Graph creds", async () => {
    const env = baseEnv({ OAUTH_MICROSOFT_ENABLED: "false" });
    delete env.MICROSOFT_GRAPH_CLIENT_ID;
    delete env.MICROSOFT_GRAPH_CLIENT_SECRET;
    process.env = env;
    const { verifyEnvAtBoot } = await import("@/lib/env");
    expect(() => verifyEnvAtBoot()).not.toThrow();
    expect(verifyEnvAtBoot().OAUTH_MICROSOFT_ENABLED).toBe(false);
  });
});

describe("envBoolean() — AI_GLOBAL_KILL_SWITCH (most safety-critical flag)", () => {
  it("AI_GLOBAL_KILL_SWITCH='false' is false (kill switch OFF)", async () => {
    process.env = baseEnv({ AI_GLOBAL_KILL_SWITCH: "false" });
    const { verifyEnvAtBoot } = await import("@/lib/env");
    expect(verifyEnvAtBoot().AI_GLOBAL_KILL_SWITCH).toBe(false);
  });

  it("AI_GLOBAL_KILL_SWITCH='true' is true (kill switch ON)", async () => {
    process.env = baseEnv({ AI_GLOBAL_KILL_SWITCH: "true" });
    const { verifyEnvAtBoot } = await import("@/lib/env");
    expect(verifyEnvAtBoot().AI_GLOBAL_KILL_SWITCH).toBe(true);
  });
});
