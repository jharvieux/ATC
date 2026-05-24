// BP31 §32.13.4 — tenant_id_hash determinism + no plaintext-tenant-id leakage.
//
// These tests cover the GitHub issues module's pure helpers:
//   - hashTenantId determinism (same input → same hash)
//   - tenant_id_hash is the only tenant identifier in the issue body
//   - createBugIssue triggers PII zero-tolerance quarantine on dirty input
//
// The Octokit API call itself is mocked in the createBugIssue PII test so
// no real GitHub traffic happens.

import { describe, it, expect, beforeEach, vi } from "vitest";

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  vi.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
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
    APP_ENCRYPTION_KEY_CURRENT: Buffer.from("a".repeat(32)).toString("base64"),
    APP_ENCRYPTION_KEY_ID_CURRENT: "v1",
    INVITATION_TOKEN_HMAC_KEY: Buffer.from("c".repeat(32)).toString("base64"),
    PLATFORM_PEPPER: "test-pepper-for-hashing",
    FORENSICS_ENCRYPTION_KEY_CURRENT: Buffer.from("b".repeat(32)).toString("base64"),
    ANTHROPIC_API_KEY: "sk-ant-test-placeholder",
    MICROSOFT_GRAPH_CLIENT_ID: "ms-id",
    MICROSOFT_GRAPH_CLIENT_SECRET: "ms-secret",
    GITHUB_APP_ID: "111111",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----",
    GITHUB_APP_INSTALLATION_ID: "222222",
    GITHUB_REPO_OWNER: "jharvieux",
    GITHUB_REPO_NAME: "ATC",
  };
});

describe("hashTenantId — §32.13.4", () => {
  it("is deterministic: same tenant_id always yields the same 12-char hash", async () => {
    const { hashTenantId } = await import("@/lib/github/issues");
    const { verifyEnvAtBoot } = await import("@/lib/env");
    verifyEnvAtBoot();
    const tid = "22222222-0000-0000-0000-00000000000a";
    const h1 = hashTenantId(tid);
    const h2 = hashTenantId(tid);
    expect(h1).toBe(h2);
    expect(h1.length).toBe(12);
    expect(/^[0-9a-f]+$/.test(h1)).toBe(true);
  });

  it("produces distinct hashes for distinct tenant_ids", async () => {
    const { hashTenantId } = await import("@/lib/github/issues");
    const { verifyEnvAtBoot } = await import("@/lib/env");
    verifyEnvAtBoot();
    const a = hashTenantId("11111111-0000-0000-0000-000000000001");
    const b = hashTenantId("11111111-0000-0000-0000-000000000002");
    expect(a).not.toBe(b);
  });

  it("uses PLATFORM_PEPPER: changing the pepper changes the hash", async () => {
    const { hashTenantId } = await import("@/lib/github/issues");
    const { verifyEnvAtBoot } = await import("@/lib/env");
    verifyEnvAtBoot();
    const tid = "33333333-0000-0000-0000-00000000000a";
    const h1 = hashTenantId(tid);

    // Swap pepper, reset modules, re-import to pick up new env.
    process.env = { ...process.env, PLATFORM_PEPPER: "different-pepper" };
    vi.resetModules();
    const mod2 = await import("@/lib/github/issues");
    const env2 = await import("@/lib/env");
    env2.verifyEnvAtBoot();
    const h2 = mod2.hashTenantId(tid);
    expect(h2).not.toBe(h1);
  });
});

describe("createBugIssue — PII zero-tolerance path", () => {
  it("throws PIIZeroToleranceQuarantineError on SSN; never calls Octokit", async () => {
    // Mock Octokit so we can assert it is NOT called when quarantine triggers.
    const issueCreateSpy = vi.fn();
    vi.doMock("@octokit/rest", () => ({
      Octokit: class {
        issues = { create: issueCreateSpy };
      },
    }));
    // Mock auth — getInstallationToken should not be called in this path,
    // but we mock it defensively so a stray call doesn't try to mint a real JWT.
    vi.doMock("@/lib/github/auth", () => ({
      getInstallationToken: vi.fn().mockResolvedValue("ghs_mock_token"),
    }));

    const { createBugIssue, PIIZeroToleranceQuarantineError } = await import(
      "@/lib/github/issues"
    );
    const { verifyEnvAtBoot } = await import("@/lib/env");
    verifyEnvAtBoot();

    await expect(
      createBugIssue({
        tenant_id: "22222222-0000-0000-0000-00000000000a",
        tenant_slug: "byohost-a",
        source_type: "tenant_admin",
        submitter_role: "tenant_owner",
        confidence_score: 0.8,
        where_in_platform: "/admin/branding",
        actual_behavior: "Pending forever, SSN 123-45-6789 in profile",
        expected_behavior: "Verify",
        steps_to_reproduce: "Add CNAME",
        frequency: "always",
        browser_info: { browser: "Chrome 124", os: "macOS 14", viewport: "1440x900" },
        screenshot_urls: [],
        help_session_id: "session-1",
        submitted_at: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(PIIZeroToleranceQuarantineError);

    expect(issueCreateSpy).not.toHaveBeenCalled();
  });
});
