// §25.4 — Customer-hash determinism and pepper sensitivity.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { deriveCustomerHash } from "@/lib/privacy/customer-hash";

describe("deriveCustomerHash", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.PLATFORM_PEPPER;
    process.env.PLATFORM_PEPPER = "test-pepper-fixture-do-not-use-in-prod";
  });
  afterEach(() => {
    if (saved !== undefined) process.env.PLATFORM_PEPPER = saved;
    else delete process.env.PLATFORM_PEPPER;
  });

  it("is deterministic for identical (user_id, tenant_id, pepper)", () => {
    const a = deriveCustomerHash("user-1", "tenant-1");
    const b = deriveCustomerHash("user-1", "tenant-1");
    expect(a).toBe(b);
  });

  it("differs when user_id differs", () => {
    expect(deriveCustomerHash("user-1", "tenant-1")).not.toBe(
      deriveCustomerHash("user-2", "tenant-1"),
    );
  });

  it("differs when tenant_id differs", () => {
    expect(deriveCustomerHash("user-1", "tenant-1")).not.toBe(
      deriveCustomerHash("user-1", "tenant-2"),
    );
  });

  it("treats null tenant_id distinct from any tenant_id", () => {
    expect(deriveCustomerHash("user-1", null)).not.toBe(
      deriveCustomerHash("user-1", "tenant-1"),
    );
  });

  it("differs when pepper changes", () => {
    const a = deriveCustomerHash("user-1", "tenant-1");
    process.env.PLATFORM_PEPPER = "different-pepper";
    const b = deriveCustomerHash("user-1", "tenant-1");
    expect(a).not.toBe(b);
  });

  it("returns 32-char base64url (URL-safe)", () => {
    const h = deriveCustomerHash("user-1", "tenant-1");
    expect(h.length).toBe(32);
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("throws when PLATFORM_PEPPER is unset", () => {
    delete process.env.PLATFORM_PEPPER;
    expect(() => deriveCustomerHash("u", "t")).toThrow(/PLATFORM_PEPPER/);
  });
});
