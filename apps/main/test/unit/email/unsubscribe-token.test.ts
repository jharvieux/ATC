// §23.3 / #1604 — Unsubscribe + companion token sign/verify tests.
// Covers the current jose HS256 scheme and legacy-format (pre-#1604)
// hand-rolled HMAC tokens, which must keep verifying indefinitely (#1604 —
// no safe cutoff date for in-flight companion/unsubscribe links).

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  signCompanionToken,
  verifyCompanionToken,
} from "@/lib/email/unsubscribe-token";

// Reproduces the pre-#1604 hand-rolled envelope (JSON + HMAC-SHA256 + base64url)
// so tests can assert old tokens issued before the jose migration still verify.
function legacySign(payload: object, purpose: "unsubscribe" | "companion", key: string, version: number | undefined = 1): string {
  const crypto = require("crypto") as typeof import("crypto");
  const versioned = version === undefined ? payload : { v: version, ...payload };
  const data = JSON.stringify(versioned);
  const mac = crypto.createHmac("sha256", key).update(`${purpose}:${data}`).digest("hex");
  return Buffer.from(JSON.stringify({ payload: data, mac })).toString("base64url");
}

describe("Unsubscribe tokens — §23.3", () => {
  beforeEach(() => {
    process.env.INVITATION_TOKEN_HMAC_KEY = "test-hmac-key-32-bytes-long-pad!!";
  });

  afterEach(() => {
    delete process.env.INVITATION_TOKEN_HMAC_KEY;
    delete process.env.COMPANION_TOKEN_HMAC_KEY;
  });

  it("sign → verify round-trip", async () => {
    const payload = { email: "guest@example.com", tenant_id: "t1", category: "marketing" };
    const token = await signUnsubscribeToken(payload);
    const result = await verifyUnsubscribeToken(token);
    expect(result).toMatchObject(payload);
  });

  it("returns null for a tampered token", async () => {
    const token = await signUnsubscribeToken({ email: "a@b.com", tenant_id: "t1", category: "all" });
    const tampered = token.slice(0, -4) + "XXXX";
    expect(await verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it("companion token round-trip", async () => {
    const payload = { booking_id: "b1", phase: "t_1" };
    const token = await signCompanionToken(payload);
    const result = await verifyCompanionToken(token);
    expect(result).toMatchObject(payload);
  });

  it("companion token uses COMPANION_TOKEN_HMAC_KEY when set", async () => {
    process.env.COMPANION_TOKEN_HMAC_KEY = "different-companion-key-32-bytes!";
    const payload = { booking_id: "b2", phase: "t_90" };
    const token = await signCompanionToken(payload);
    // Should verify with the companion key
    expect(await verifyCompanionToken(token)).toMatchObject(payload);
  });

  it("companion token signed with companion key does not verify with invitation key alone", async () => {
    process.env.COMPANION_TOKEN_HMAC_KEY = "companion-specific-key-32-bytes!!";
    const payload = { booking_id: "b3", phase: "t_30" };
    const token = await signCompanionToken(payload);

    // Remove companion key — falls back to invitation key, which is different
    delete process.env.COMPANION_TOKEN_HMAC_KEY;
    expect(await verifyCompanionToken(token)).toBeNull();
  });

  it("hmacKey() throws if neither env var is set (audit Finding 3)", async () => {
    delete process.env.INVITATION_TOKEN_HMAC_KEY;
    await expect(signUnsubscribeToken({ email: "a@b.com", tenant_id: "t", category: "x" })).rejects.toThrow(
      /Missing HMAC key/,
    );
  });

  it("companion token verify rejects past-expiry tokens (audit Finding 2)", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = await signCompanionToken({ booking_id: "b", phase: "t_1", exp: past });
    expect(await verifyCompanionToken(token)).toBeNull();
  });

  it("a token signed for one purpose does not verify under the other (per-purpose aud, #1604)", async () => {
    const unsubToken = await signUnsubscribeToken({ email: "a@b.com", tenant_id: "t1", category: "marketing" });
    // Feeding an unsubscribe token to the companion verifier must fail even
    // though both purposes can share the same underlying secret.
    expect(await verifyCompanionToken(unsubToken)).toBeNull();
  });

  // Legacy (pre-#1604) hand-rolled HMAC format — must keep verifying
  // indefinitely; see the module doc comment for why there's no cutoff date.

  it("legacy-format unsubscribe token (issued before the jose migration) still verifies (#1604 old-format fixture)", async () => {
    const key = "test-hmac-key-32-bytes-long-pad!!";
    const payload = { email: "legacy@example.com", tenant_id: "t1", category: "marketing" };
    const legacyToken = legacySign(payload, "unsubscribe", key);
    expect(await verifyUnsubscribeToken(legacyToken)).toMatchObject(payload);
  });

  it("legacy-format companion token (issued before the jose migration) still verifies (#1604 old-format fixture)", async () => {
    const key = "test-hmac-key-32-bytes-long-pad!!";
    const future = Math.floor(Date.now() / 1000) + 3600;
    const payload = { booking_id: "legacy-b", phase: "t_30", exp: future };
    const legacyToken = legacySign(payload, "companion", key);
    expect(await verifyCompanionToken(legacyToken)).toMatchObject({ booking_id: "legacy-b", phase: "t_30" });
  });

  it("verify rejects a legacy token with an unknown future version (audit Finding 12)", async () => {
    const key = "test-hmac-key-32-bytes-long-pad!!";
    const legacyToken = legacySign({ booking_id: "b", phase: "t_1" }, "companion", key, 2);
    expect(await verifyCompanionToken(legacyToken)).toBeNull();
  });

  it("verify still accepts legacy pre-versioning tokens (no v field) for backward compat", async () => {
    const key = "test-hmac-key-32-bytes-long-pad!!";
    const future = Math.floor(Date.now() / 1000) + 3600;
    const legacyToken = legacySign({ booking_id: "b", phase: "t_1", exp: future }, "companion", key, undefined);
    expect(await verifyCompanionToken(legacyToken)).toMatchObject({ booking_id: "b", phase: "t_1" });
  });

  it("legacy verify rejects a tampered legacy token", async () => {
    const key = "test-hmac-key-32-bytes-long-pad!!";
    const legacyToken = legacySign({ email: "a@b.com", tenant_id: "t1", category: "all" }, "unsubscribe", key);
    const tampered = legacyToken.slice(0, -4) + "XXXX";
    expect(await verifyUnsubscribeToken(tampered)).toBeNull();
  });
});
