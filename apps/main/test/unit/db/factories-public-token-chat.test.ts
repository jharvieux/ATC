// F1 — tenantContextForPublicTokenChat: validation guards.

import { describe, it, expect } from "vitest";
import { tenantContextForPublicTokenChat } from "@/lib/db/factories";

const VALID_TENANT = "11111111-2222-3333-4444-555555555555";
const VALID_HASH = "a".repeat(64);

describe("tenantContextForPublicTokenChat", () => {
  it("constructs a TenantContext with the public_token_chat source kind", () => {
    const ctx = tenantContextForPublicTokenChat({
      tenant_id: VALID_TENANT,
      token_hash: VALID_HASH,
    });
    expect(ctx.tenant_id).toBe(VALID_TENANT);
    expect(ctx.source.kind).toBe("public_token_chat");
    if (ctx.source.kind === "public_token_chat") {
      expect(ctx.source.token_hash).toBe(VALID_HASH);
    }
  });

  it("rejects an empty tenant_id", () => {
    expect(() =>
      tenantContextForPublicTokenChat({ tenant_id: "", token_hash: VALID_HASH }),
    ).toThrow(/tenant_id/);
  });

  it("rejects a malformed tenant_id (not UUID-shaped)", () => {
    expect(() =>
      tenantContextForPublicTokenChat({ tenant_id: "not-a-uuid", token_hash: VALID_HASH }),
    ).toThrow(/tenant_id/);
  });

  it("rejects a token_hash that isn't 64-char hex", () => {
    expect(() =>
      tenantContextForPublicTokenChat({ tenant_id: VALID_TENANT, token_hash: "tooshort" }),
    ).toThrow(/token_hash/);
    expect(() =>
      tenantContextForPublicTokenChat({ tenant_id: VALID_TENANT, token_hash: "Z".repeat(64) }),
    ).toThrow(/token_hash/);
  });

  it("rejects an empty token_hash", () => {
    expect(() =>
      tenantContextForPublicTokenChat({ tenant_id: VALID_TENANT, token_hash: "" }),
    ).toThrow(/token_hash/);
  });
});
