// §23.3 — Unsubscribe + companion token sign/verify tests.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  signCompanionToken,
  verifyCompanionToken,
} from "@/lib/email/unsubscribe-token";

describe("Unsubscribe tokens — §23.3", () => {
  beforeEach(() => {
    process.env.INVITATION_TOKEN_HMAC_KEY = "test-hmac-key-32-bytes-long-pad!!";
  });

  afterEach(() => {
    delete process.env.INVITATION_TOKEN_HMAC_KEY;
    delete process.env.COMPANION_TOKEN_HMAC_KEY;
  });

  it("sign → verify round-trip", () => {
    const payload = { email: "guest@example.com", tenant_id: "t1", category: "marketing" };
    const token = signUnsubscribeToken(payload);
    const result = verifyUnsubscribeToken(token);
    expect(result).toMatchObject(payload);
  });

  it("returns null for a tampered token", () => {
    const token = signUnsubscribeToken({ email: "a@b.com", tenant_id: "t1", category: "all" });
    const tampered = token.slice(0, -4) + "XXXX";
    expect(verifyUnsubscribeToken(tampered)).toBeNull();
  });

  it("companion token round-trip", () => {
    const payload = { booking_id: "b1", phase: "t_1" };
    const token = signCompanionToken(payload);
    const result = verifyCompanionToken(token);
    expect(result).toMatchObject(payload);
  });

  it("companion token uses COMPANION_TOKEN_HMAC_KEY when set", () => {
    process.env.COMPANION_TOKEN_HMAC_KEY = "different-companion-key-32-bytes!";
    const payload = { booking_id: "b2", phase: "t_90" };
    const token = signCompanionToken(payload);
    // Should verify with the companion key
    expect(verifyCompanionToken(token)).toMatchObject(payload);
  });

  it("companion token signed with companion key does not verify with invitation key alone", () => {
    process.env.COMPANION_TOKEN_HMAC_KEY = "companion-specific-key-32-bytes!!";
    const payload = { booking_id: "b3", phase: "t_30" };
    const token = signCompanionToken(payload);

    // Remove companion key — falls back to invitation key, which is different
    delete process.env.COMPANION_TOKEN_HMAC_KEY;
    expect(verifyCompanionToken(token)).toBeNull();
  });

  // 2026-05-25 audit pass 2 hardenings.

  it("hmacKey() throws if neither env var is set (audit Finding 3)", () => {
    delete process.env.INVITATION_TOKEN_HMAC_KEY;
    expect(() => signUnsubscribeToken({ email: "a@b.com", tenant_id: "t", category: "x" })).toThrow(
      /Missing HMAC key/,
    );
  });

  it("companion token verify rejects past-expiry tokens (audit Finding 2)", () => {
    // Sign with a custom exp in the past.
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = signCompanionToken({ booking_id: "b", phase: "t_1", exp: past });
    expect(verifyCompanionToken(token)).toBeNull();
  });

  it("freshly signed tokens carry v=1 (audit Finding 12)", () => {
    const token = signCompanionToken({ booking_id: "b", phase: "t_1" });
    const decoded = verifyCompanionToken(token);
    expect(decoded?.v).toBe(1);
  });

  it("verify rejects tokens with an unknown future version (audit Finding 12)", () => {
    // Hand-craft a token with v=2 to simulate a future schema.
    const key = "test-hmac-key-32-bytes-long-pad!!";
    const payload = JSON.stringify({ v: 2, booking_id: "b", phase: "t_1" });
    const crypto = require("crypto") as typeof import("crypto");
    const mac = crypto.createHmac("sha256", key).update(`companion:${payload}`).digest("hex");
    const token = Buffer.from(JSON.stringify({ payload, mac })).toString("base64url");
    expect(verifyCompanionToken(token)).toBeNull();
  });

  it("verify still accepts pre-versioning tokens (no v field) for backward compat", () => {
    // Hand-craft an unversioned token.
    const key = "test-hmac-key-32-bytes-long-pad!!";
    const future = Math.floor(Date.now() / 1000) + 3600;
    const payload = JSON.stringify({ booking_id: "b", phase: "t_1", exp: future });
    const crypto = require("crypto") as typeof import("crypto");
    const mac = crypto.createHmac("sha256", key).update(`companion:${payload}`).digest("hex");
    const token = Buffer.from(JSON.stringify({ payload, mac })).toString("base64url");
    expect(verifyCompanionToken(token)).toMatchObject({ booking_id: "b", phase: "t_1" });
  });
});
