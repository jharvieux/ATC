// BP28 — env-var defaults verified at boot.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const APP_KEY_B64 = Buffer.from("a".repeat(32)).toString("base64");
const FORENSICS_KEY_B64 = Buffer.from("b".repeat(32)).toString("base64");
const HMAC_KEY_B64 = Buffer.from("c".repeat(32)).toString("base64");

let originalEnv: NodeJS.ProcessEnv;

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
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
    SERVICE_JWT_KEY_ID: "kid1",
    RAG_SERVICE_URL: "https://rag.test.example.com",
    RAG_WEBHOOK_SECRET: "rag-secret",
    APP_ENCRYPTION_KEY_CURRENT: APP_KEY_B64,
    APP_ENCRYPTION_KEY_ID_CURRENT: "v1",
    INVITATION_TOKEN_HMAC_KEY: HMAC_KEY_B64,
    PLATFORM_PEPPER: "test-pepper",
    FORENSICS_ENCRYPTION_KEY_CURRENT: FORENSICS_KEY_B64,
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

beforeEach(() => { originalEnv = process.env; vi.resetModules(); });
afterEach(() => { process.env = originalEnv; });

describe("BP28 env vars — defaults", () => {
  it("ABUSE_RECOMPUTE_CRON_SCHEDULE defaults to '0 3 * * *'", async () => {
    process.env = baseEnv({ ABUSE_RECOMPUTE_CRON_SCHEDULE: undefined });
    const { verifyEnvAtBoot, env } = await import("@/lib/env");
    verifyEnvAtBoot();
    expect(env().ABUSE_RECOMPUTE_CRON_SCHEDULE).toBe("0 3 * * *");
  });

  it("ABUSE_OVERRIDE_DEFAULT_DURATION_DAYS defaults to 30", async () => {
    process.env = baseEnv({ ABUSE_OVERRIDE_DEFAULT_DURATION_DAYS: undefined });
    const { verifyEnvAtBoot, env } = await import("@/lib/env");
    verifyEnvAtBoot();
    expect(env().ABUSE_OVERRIDE_DEFAULT_DURATION_DAYS).toBe(30);
  });

  it("ABUSE_TENANT_USAGE_REFRESH_SECONDS defaults to 60", async () => {
    process.env = baseEnv({ ABUSE_TENANT_USAGE_REFRESH_SECONDS: undefined });
    const { verifyEnvAtBoot, env } = await import("@/lib/env");
    verifyEnvAtBoot();
    expect(env().ABUSE_TENANT_USAGE_REFRESH_SECONDS).toBe(60);
  });

  it("accepts explicit override values", async () => {
    process.env = baseEnv({
      ABUSE_RECOMPUTE_CRON_SCHEDULE: "15 4 * * *",
      ABUSE_OVERRIDE_DEFAULT_DURATION_DAYS: "14",
      ABUSE_TENANT_USAGE_REFRESH_SECONDS: "120",
    });
    const { verifyEnvAtBoot, env } = await import("@/lib/env");
    verifyEnvAtBoot();
    expect(env().ABUSE_RECOMPUTE_CRON_SCHEDULE).toBe("15 4 * * *");
    expect(env().ABUSE_OVERRIDE_DEFAULT_DURATION_DAYS).toBe(14);
    expect(env().ABUSE_TENANT_USAGE_REFRESH_SECONDS).toBe(120);
  });

  it("rejects ABUSE_OVERRIDE_DEFAULT_DURATION_DAYS=0 (must be positive)", async () => {
    process.env = baseEnv({ ABUSE_OVERRIDE_DEFAULT_DURATION_DAYS: "0" });
    const { verifyEnvAtBoot } = await import("@/lib/env");
    expect(() => verifyEnvAtBoot()).toThrow();
  });
});
