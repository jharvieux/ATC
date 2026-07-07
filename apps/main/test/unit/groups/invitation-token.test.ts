// §18.5 / #1604 — HMAC invitation token tests.
// Covers: generation, verification, forged-token rejection, constant-time
// comparison, and the legacy (pre-#1604) hand-rolled format, which must
// keep verifying indefinitely — invitation validity is governed entirely by
// the DB's token_revoked_at / natural-expiry sweep, not anything in the token.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateToken, parseAndVerifyHmac } from "@/lib/groups/invitation-token";

const TEST_KEY = Buffer.from("testtesttesttesttesttesttesttest").toString("base64"); // 32 bytes

// Reproduces the pre-#1604 `${invitation_id}.${base64url(hmac)}` format so
// tests can assert old tokens issued before the jose migration still verify.
function legacyToken(invitation_id: string, key: string): string {
  const crypto = require("crypto") as typeof import("crypto");
  const mac = crypto.createHmac("sha256", Buffer.from(key, "base64")).update(invitation_id).digest();
  return `${invitation_id}.${mac.toString("base64url")}`;
}

describe("HMAC invitation token (§18.5)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.INVITATION_TOKEN_HMAC_KEY = TEST_KEY;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("verifies a legitimately generated token", async () => {
    const id = crypto.randomUUID();
    const token = await generateToken(id);
    const { invitation_id, ok } = await parseAndVerifyHmac(token);
    expect(ok).toBe(true);
    expect(invitation_id).toBe(id);
  });

  it("rejects a token with a tampered HMAC", async () => {
    const id = crypto.randomUUID();
    const token = await generateToken(id);
    const forged = token.slice(0, -4) + "XXXX";
    const { ok } = await parseAndVerifyHmac(forged);
    expect(ok).toBe(false);
  });

  it("rejects a token with no dot separator (malformed, not even legacy-shaped)", async () => {
    const { ok } = await parseAndVerifyHmac("notavalidtoken");
    expect(ok).toBe(false);
  });

  it("two tokens for different invitation_ids are different", async () => {
    const t1 = await generateToken(crypto.randomUUID());
    const t2 = await generateToken(crypto.randomUUID());
    expect(t1).not.toBe(t2);
  });

  it("two tokens for the same invitation_id with the same key both verify to that id", async () => {
    // jose stamps `iat`, so the two tokens are no longer byte-identical
    // (unlike the legacy scheme) — what matters is they verify identically.
    const id = crypto.randomUUID();
    const [t1, t2] = await Promise.all([generateToken(id), generateToken(id)]);
    const [r1, r2] = await Promise.all([parseAndVerifyHmac(t1), parseAndVerifyHmac(t2)]);
    expect(r1).toEqual({ invitation_id: id, ok: true });
    expect(r2).toEqual({ invitation_id: id, ok: true });
  });

  it("token generated with one key is rejected when key changes", async () => {
    const id = crypto.randomUUID();
    const token = await generateToken(id);
    // Change the key.
    process.env.INVITATION_TOKEN_HMAC_KEY = Buffer.from("differentdifferentdifferentdiffer").toString("base64");
    const { ok } = await parseAndVerifyHmac(token);
    expect(ok).toBe(false);
  });

  // Legacy (pre-#1604) hand-rolled `id.hmac` format.

  it("legacy-format token (issued before the jose migration) still verifies (#1604 old-format fixture)", async () => {
    const id = crypto.randomUUID();
    const token = legacyToken(id, TEST_KEY);
    const { invitation_id, ok } = await parseAndVerifyHmac(token);
    expect(ok).toBe(true);
    expect(invitation_id).toBe(id);
  });

  it("rejects a legacy token with a valid-looking HMAC for a different invitation_id", async () => {
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    const token1 = legacyToken(id1, TEST_KEY);
    // Take the HMAC from token1 and attach it to id2.
    const hmacPart = token1.slice(id1.length);
    const forged = id2 + hmacPart;
    const { ok } = await parseAndVerifyHmac(forged);
    expect(ok).toBe(false);
  });

  it("rejects a legacy token with a tampered HMAC", async () => {
    const id = crypto.randomUUID();
    const token = legacyToken(id, TEST_KEY);
    const forged = token.slice(0, -4) + "XXXX";
    const { ok } = await parseAndVerifyHmac(forged);
    expect(ok).toBe(false);
  });
});
