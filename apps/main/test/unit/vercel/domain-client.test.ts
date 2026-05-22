// §16.3.4 — Crown-jewel guard tests for the Vercel domain client.
// The CrownJewelGuardError MUST fire whenever PLATFORM_ENV !== 'production',
// regardless of whether VERCEL_API_TOKEN happens to be set.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("vercelAddDomain crown-jewel guard (§16.3.4)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("throws CrownJewelGuardError when PLATFORM_ENV is 'staging'", async () => {
    process.env.PLATFORM_ENV = "staging";
    process.env.VERCEL_API_TOKEN = "fake-token";
    process.env.VERCEL_PROJECT_ID = "prj_fake";
    const { vercelAddDomain, CrownJewelGuardError } = await import("@/lib/vercel/domain-client");
    await expect(vercelAddDomain("test.example.com")).rejects.toBeInstanceOf(CrownJewelGuardError);
  });

  it("throws CrownJewelGuardError when PLATFORM_ENV is 'preview'", async () => {
    process.env.PLATFORM_ENV = "preview";
    process.env.VERCEL_API_TOKEN = "fake-token";
    process.env.VERCEL_PROJECT_ID = "prj_fake";
    const { vercelAddDomain, CrownJewelGuardError } = await import("@/lib/vercel/domain-client");
    await expect(vercelAddDomain("test.example.com")).rejects.toBeInstanceOf(CrownJewelGuardError);
  });

  it("throws CrownJewelGuardError when PLATFORM_ENV is 'development'", async () => {
    process.env.PLATFORM_ENV = "development";
    process.env.VERCEL_API_TOKEN = "fake-token";
    process.env.VERCEL_PROJECT_ID = "prj_fake";
    const { vercelAddDomain, CrownJewelGuardError } = await import("@/lib/vercel/domain-client");
    await expect(vercelAddDomain("test.example.com")).rejects.toBeInstanceOf(CrownJewelGuardError);
  });

  it("throws CrownJewelGuardError when PLATFORM_ENV is unset", async () => {
    delete process.env.PLATFORM_ENV;
    process.env.VERCEL_API_TOKEN = "fake-token";
    process.env.VERCEL_PROJECT_ID = "prj_fake";
    const { vercelAddDomain, CrownJewelGuardError } = await import("@/lib/vercel/domain-client");
    await expect(vercelAddDomain("test.example.com")).rejects.toBeInstanceOf(CrownJewelGuardError);
  });

  it("vercelRemoveDomain also enforces the guard", async () => {
    process.env.PLATFORM_ENV = "staging";
    process.env.VERCEL_API_TOKEN = "fake-token";
    process.env.VERCEL_PROJECT_ID = "prj_fake";
    const { vercelRemoveDomain, CrownJewelGuardError } = await import("@/lib/vercel/domain-client");
    await expect(vercelRemoveDomain("test.example.com")).rejects.toBeInstanceOf(CrownJewelGuardError);
  });

  it("guard error message mentions §16.3.4 and the current PLATFORM_ENV", async () => {
    process.env.PLATFORM_ENV = "staging";
    process.env.VERCEL_API_TOKEN = "fake-token";
    process.env.VERCEL_PROJECT_ID = "prj_fake";
    const { vercelAddDomain } = await import("@/lib/vercel/domain-client");
    try {
      await vercelAddDomain("test.example.com");
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("§16.3.4");
      expect((err as Error).message).toContain("staging");
    }
  });
});
