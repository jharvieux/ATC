// §24.x / #1604 — HMAC-signed anonymous session cookie tests.
//
// Tests verify WHY the behavior matters:
//   - A valid signed cookie is accepted and its UUID extracted — this is the
//     normal flow on every request after the first.
//   - A tampered signature is rejected so attackers can't forge session IDs to
//     bypass rate limits or hijack conversation history.
//   - A plain UUID cookie (no ".") is rejected — the §24.x migration window
//     is closed, so an unsigned cookie has no valid signature (#514).
//   - A fresh session generates a UUID that round-trips through sign/verify.
//   - buildAnonCookieHeader produces an HttpOnly; SameSite=Lax header so
//     the cookie cannot be read by client-side JS (rate-limit bypass prevention).
//   - Legacy (pre-#1604) `<uuid>.<hex-mac>` cookies still verify — a 30-day
//     Max-Age means old cookies are naturally gone within a month of deploy,
//     but there's no reason to force an early reset.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";

vi.stubEnv("ANON_COOKIE_SECRET", "test-secret-1234");

// Import AFTER stubbing env so the module picks up the secret.
const { signAnonSession, verifyAnonSession, freshAnonSession, buildAnonCookieHeader, ANON_SESSION_COOKIE } =
  await import("@/lib/chat/anon-session-cookie");

const TEST_UUID = "550e8400-e29b-41d4-a716-446655440000";

// Reproduces the pre-#1604 `<uuid>.<hex-hmac>` format.
function legacyCookie(uuid: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(uuid).digest("hex");
  return `${uuid}.${mac}`;
}

describe("signAnonSession / verifyAnonSession — §24.x", () => {
  it("round-trips: sign then verify returns the original UUID", async () => {
    const signed = await signAnonSession(TEST_UUID);
    expect(await verifyAnonSession(signed)).toBe(TEST_UUID);
  });

  it("rejects a tampered MAC — attacker cannot forge a valid session ID", async () => {
    const signed = await signAnonSession(TEST_UUID);
    const tampered = signed.slice(0, -3) + "000";
    expect(await verifyAnonSession(tampered)).toBeNull();
  });

  it("rejects a completely invalid value", async () => {
    expect(await verifyAnonSession("not-valid")).toBeNull();
    expect(await verifyAnonSession("")).toBeNull();
  });

  it("rejects an unsigned cookie — migration window closed, signature now mandatory (#514)", async () => {
    // A bare UUID with no ".<mac>" was grandfathered in during the §24.x
    // migration window so in-flight sessions survived the deploy. That window
    // is closed: an unsigned cookie must now be rejected so a client cannot
    // present a self-chosen UUID, skip the HMAC check, and hijack a session or
    // bypass per-session rate limits. Payload shape is irrelevant — a
    // UUID-shaped value and a junk value are both rejected for lacking a sig.
    expect(await verifyAnonSession(TEST_UUID)).toBeNull();
    expect(await verifyAnonSession("short")).toBeNull();
    expect(await verifyAnonSession("not-a-uuid-at-all-xxxx")).toBeNull();
  });

  it("signed value is different from UUID — the MAC is appended", async () => {
    const signed = await signAnonSession(TEST_UUID);
    expect(signed).not.toBe(TEST_UUID);
  });

  it("legacy-format cookie (issued before the jose migration) still verifies (#1604 old-format fixture)", async () => {
    const cookie = legacyCookie(TEST_UUID, "test-secret-1234");
    expect(await verifyAnonSession(cookie)).toBe(TEST_UUID);
  });

  it("rejects a tampered legacy cookie", async () => {
    const cookie = legacyCookie(TEST_UUID, "test-secret-1234");
    const tampered = cookie.slice(0, -3) + "000";
    expect(await verifyAnonSession(tampered)).toBeNull();
  });
});

describe("freshAnonSession — §24.x", () => {
  it("generates a UUID that verifies correctly", async () => {
    const { id, cookieValue } = await freshAnonSession();
    expect(await verifyAnonSession(cookieValue)).toBe(id);
  });

  it("two fresh sessions produce different IDs", async () => {
    const a = await freshAnonSession();
    const b = await freshAnonSession();
    expect(a.id).not.toBe(b.id);
  });
});

describe("buildAnonCookieHeader — §24.x", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
  });

  it("includes HttpOnly so client JS cannot read the session ID", () => {
    const header = buildAnonCookieHeader("some-value");
    expect(header).toContain("HttpOnly");
  });

  it("includes SameSite=Lax to prevent CSRF", () => {
    const header = buildAnonCookieHeader("some-value");
    expect(header).toContain("SameSite=Lax");
  });

  it("cookie name matches ANON_SESSION_COOKIE constant", () => {
    const header = buildAnonCookieHeader("some-value");
    expect(header.startsWith(`${ANON_SESSION_COOKIE}=`)).toBe(true);
  });

  it("does not include Secure in non-production — dev requests work over http", () => {
    vi.stubEnv("NODE_ENV", "development");
    const header = buildAnonCookieHeader("some-value");
    expect(header).not.toContain("Secure");
  });

  it("includes Secure in production — prevents cookie leak over plaintext", () => {
    vi.stubEnv("NODE_ENV", "production");
    const header = buildAnonCookieHeader("some-value");
    expect(header).toContain("Secure");
  });
});
