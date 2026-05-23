// §24.8 — Fingerprint derivation is deterministic per header bundle and
// reasonably resistant to casual evasion (different UA = different hash).

import { describe, it, expect } from "vitest";
import { deriveFingerprint, extractClientIp } from "@/lib/chat/fingerprint";

function reqWith(headers: Record<string, string>): Request {
  return new Request("https://t.example.com/api/chat", { headers });
}

describe("deriveFingerprint", () => {
  it("is deterministic for identical headers", () => {
    const a = deriveFingerprint(reqWith({ "user-agent": "ua1", "accept-language": "en" }));
    const b = deriveFingerprint(reqWith({ "user-agent": "ua1", "accept-language": "en" }));
    expect(a).toBe(b);
  });
  it("differs when user-agent differs", () => {
    const a = deriveFingerprint(reqWith({ "user-agent": "ua1" }));
    const b = deriveFingerprint(reqWith({ "user-agent": "ua2" }));
    expect(a).not.toBe(b);
  });
  it("returns a 32-char hex slice", () => {
    const a = deriveFingerprint(reqWith({ "user-agent": "x" }));
    expect(a).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe("extractClientIp", () => {
  it("prefers x-forwarded-for first value", () => {
    expect(extractClientIp(reqWith({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("1.2.3.4");
  });
  it("falls back to x-real-ip", () => {
    expect(extractClientIp(reqWith({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
  });
  it("returns empty when no IP header present", () => {
    expect(extractClientIp(reqWith({}))).toBe("");
  });
});
