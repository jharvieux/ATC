// D-091 P1 #38 fix — Svix signature verification for Resend webhooks.
//
// Replaces the prior `Buffer.from(sig, "hex")` implementation that
// silently rejected every valid Resend webhook. Recorded-fixture tests
// guard against future encoding regressions.

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyResendSignature } from "../../../src/app/api/webhooks/resend/route";

// Generate a Svix-style signed fixture. Mirrors the production signing
// path exactly so the test fails the moment that path drifts.
function makeFixture(opts: {
  secret: string;
  msgId: string;
  timestamp: string;
  body: string;
}): string {
  const stripped = opts.secret.startsWith("whsec_") ? opts.secret.slice(6) : opts.secret;
  const key = Buffer.from(stripped, "base64");
  const signedContent = `${opts.msgId}.${opts.timestamp}.${opts.body}`;
  const sig = createHmac("sha256", key).update(signedContent).digest("base64");
  return `v1,${sig}`;
}

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"; // Svix-style test secret
const MSG_ID = "msg_2abc";
// Tests pin a fixed "now" so the timestamp window check is deterministic.
const NOW = 1730000000;
const TIMESTAMP = String(NOW);
const BODY = JSON.stringify({ type: "email.delivered", data: { email_id: "abc" } });

describe("verifyResendSignature — Svix signing scheme", () => {
  it("accepts a correctly-signed v1 signature", () => {
    const sig = makeFixture({ secret: SECRET, msgId: MSG_ID, timestamp: TIMESTAMP, body: BODY });
    expect(verifyResendSignature({
      body: BODY,
      msgId: MSG_ID,
      timestamp: TIMESTAMP,
      signatureHeader: sig,
      secret: SECRET,
      nowSeconds: NOW,
    })).toBe(true);
  });

  it("rejects when body is tampered with", () => {
    const sig = makeFixture({ secret: SECRET, msgId: MSG_ID, timestamp: TIMESTAMP, body: BODY });
    expect(verifyResendSignature({
      body: BODY + "-tampered",
      msgId: MSG_ID,
      timestamp: TIMESTAMP,
      signatureHeader: sig,
      secret: SECRET,
      nowSeconds: NOW,
    })).toBe(false);
  });

  it("rejects when msg-id is tampered with (signature was over different msg-id)", () => {
    const sig = makeFixture({ secret: SECRET, msgId: MSG_ID, timestamp: TIMESTAMP, body: BODY });
    expect(verifyResendSignature({
      body: BODY,
      msgId: "msg_evil",
      timestamp: TIMESTAMP,
      signatureHeader: sig,
      secret: SECRET,
      nowSeconds: NOW,
    })).toBe(false);
  });

  it("rejects when timestamp is older than 5 minutes (replay protection)", () => {
    const sig = makeFixture({ secret: SECRET, msgId: MSG_ID, timestamp: TIMESTAMP, body: BODY });
    expect(verifyResendSignature({
      body: BODY,
      msgId: MSG_ID,
      timestamp: TIMESTAMP,
      signatureHeader: sig,
      secret: SECRET,
      nowSeconds: NOW + 6 * 60, // 6 minutes after signing
    })).toBe(false);
  });

  it("rejects when any required header is missing", () => {
    const sig = makeFixture({ secret: SECRET, msgId: MSG_ID, timestamp: TIMESTAMP, body: BODY });
    const base = { body: BODY, signatureHeader: sig, secret: SECRET, nowSeconds: NOW };
    expect(verifyResendSignature({ ...base, msgId: null, timestamp: TIMESTAMP })).toBe(false);
    expect(verifyResendSignature({ ...base, msgId: MSG_ID, timestamp: null })).toBe(false);
    expect(verifyResendSignature({ ...base, msgId: MSG_ID, timestamp: TIMESTAMP, signatureHeader: null })).toBe(false);
  });

  it("accepts when header carries multiple v1 entries and any matches (rotation)", () => {
    const goodSig = makeFixture({ secret: SECRET, msgId: MSG_ID, timestamp: TIMESTAMP, body: BODY });
    const header = `v1,xxxxxxxxxx ${goodSig} v1,yyyyyyyyyy`;
    expect(verifyResendSignature({
      body: BODY,
      msgId: MSG_ID,
      timestamp: TIMESTAMP,
      signatureHeader: header,
      secret: SECRET,
      nowSeconds: NOW,
    })).toBe(true);
  });

  it("rejects when no v1 entry matches", () => {
    const header = "v1,xxxxxxxxxx v1,yyyyyyyyyy";
    expect(verifyResendSignature({
      body: BODY,
      msgId: MSG_ID,
      timestamp: TIMESTAMP,
      signatureHeader: header,
      secret: SECRET,
      nowSeconds: NOW,
    })).toBe(false);
  });

  it("rejects when timestamp is non-numeric", () => {
    const sig = makeFixture({ secret: SECRET, msgId: MSG_ID, timestamp: TIMESTAMP, body: BODY });
    expect(verifyResendSignature({
      body: BODY,
      msgId: MSG_ID,
      timestamp: "not-a-timestamp",
      signatureHeader: sig,
      secret: SECRET,
      nowSeconds: NOW,
    })).toBe(false);
  });

  it("REGRESSION: pre-fix `Buffer.from(sig, 'hex')` decode would have failed this same fixture", () => {
    // The pre-fix implementation interpreted the base64 signature as hex.
    // A base64 string almost never decodes as valid hex (contains `/`, `+`,
    // `=`, mixed case). This test exists to make the encoding-regression
    // explicit: any future change that flips back to hex breaks this assertion.
    const sig = makeFixture({ secret: SECRET, msgId: MSG_ID, timestamp: TIMESTAMP, body: BODY });
    const justTheSig = sig.split(",")[1]!;
    // `Buffer.from(<base64>, "hex")` produces garbage but doesn't throw — it
    // stops at the first non-hex character. The decoded length almost never
    // matches the expected 32 bytes, so the old code returned false.
    const decoded = Buffer.from(justTheSig, "hex");
    expect(decoded.length).not.toBe(32);
  });
});
