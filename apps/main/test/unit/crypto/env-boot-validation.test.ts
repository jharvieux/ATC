// Tests for verifyEnvAtBoot() encryption key validation (§13.5.3).
// Kept in a separate file so it has no module-level env mock.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

const VALID_KEY_B64 = Buffer.from("a".repeat(32)).toString("base64");

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = process.env;
});

afterEach(() => {
  process.env = originalEnv;
});

describe("verifyEnvAtBoot — encryption key validation (§13.5.3)", () => {
  it("rejects APP_ENCRYPTION_KEY_CURRENT that decodes to fewer than 32 bytes", async () => {
    const shortKey = Buffer.from("tooshort").toString("base64"); // 8 bytes

    // Build a minimal valid env (required fields for zod schema)
    process.env = {
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
      APP_ENCRYPTION_KEY_CURRENT: shortKey,
      APP_ENCRYPTION_KEY_ID_CURRENT: "v1",
    };

    const { verifyEnvAtBoot } = await import("@/lib/env");
    expect(() => verifyEnvAtBoot()).toThrow(/32 bytes/);
  });

  it("accepts a valid 32-byte base64 key", async () => {
    process.env = {
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
      APP_ENCRYPTION_KEY_CURRENT: VALID_KEY_B64,
      APP_ENCRYPTION_KEY_ID_CURRENT: "v1",
    };

    const { verifyEnvAtBoot } = await import("@/lib/env");
    expect(() => verifyEnvAtBoot()).not.toThrow();
  });
});
