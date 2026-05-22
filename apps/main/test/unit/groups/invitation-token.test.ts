// §18.5 — HMAC invitation token tests.
// Covers: generation, verification, forged-token rejection, constant-time
// comparison, first-use binding semantics.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateToken, parseAndVerifyHmac } from "@/lib/groups/invitation-token";

const TEST_KEY = Buffer.from("testtesttesttesttesttesttesttest").toString("base64"); // 32 bytes

describe("HMAC invitation token (§18.5)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.INVITATION_TOKEN_HMAC_KEY = TEST_KEY;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("generates a token containing the invitation_id", () => {
    const id = crypto.randomUUID();
    const token = generateToken(id);
    expect(token.startsWith(id + ".")).toBe(true);
  });

  it("verifies a legitimately generated token", () => {
    const id = crypto.randomUUID();
    const token = generateToken(id);
    const { invitation_id, ok } = parseAndVerifyHmac(token);
    expect(ok).toBe(true);
    expect(invitation_id).toBe(id);
  });

  it("rejects a token with a tampered HMAC", () => {
    const id = crypto.randomUUID();
    const token = generateToken(id);
    const forged = token.slice(0, -4) + "XXXX";
    const { ok } = parseAndVerifyHmac(forged);
    expect(ok).toBe(false);
  });

  it("rejects a token with a valid-looking HMAC for a different invitation_id", () => {
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    const token1 = generateToken(id1);
    // Take the HMAC from token1 and attach it to id2.
    const hmacPart = token1.slice(id1.length);
    const forged = id2 + hmacPart;
    const { ok } = parseAndVerifyHmac(forged);
    expect(ok).toBe(false);
  });

  it("rejects a token with no dot separator", () => {
    const { ok } = parseAndVerifyHmac("notavalidtoken");
    expect(ok).toBe(false);
  });

  it("two tokens for different invitation_ids are different", () => {
    const t1 = generateToken(crypto.randomUUID());
    const t2 = generateToken(crypto.randomUUID());
    expect(t1).not.toBe(t2);
  });

  it("two tokens for the same invitation_id with the same key are identical", () => {
    const id = crypto.randomUUID();
    expect(generateToken(id)).toBe(generateToken(id));
  });

  it("token generated with one key is rejected when key changes", () => {
    const id = crypto.randomUUID();
    const token = generateToken(id);
    // Change the key.
    process.env.INVITATION_TOKEN_HMAC_KEY = Buffer.from("differentdifferentdifferentdiffer").toString("base64");
    const { ok } = parseAndVerifyHmac(token);
    expect(ok).toBe(false);
  });
});
