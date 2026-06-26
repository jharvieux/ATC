// §16.4 — from-address resolution precedence.
// Verifies the rules in send.ts:resolveFromAddress so a future refactor
// can't silently regress to "always send under noreply@platform.com" or
// "always send under unverified tenant domain" (would generate bounces).

import { describe, it, expect } from "vitest";
import { resolveFromAddress } from "@/lib/email/send";

describe("resolveFromAddress (§16.4 precedence)", () => {
  it("falls back to platform default when nothing is set", () => {
    expect(
      resolveFromAddress({
        email_from_address: null,
        email_from_domain: null,
        email_from_domain_verified_at: null,
      }),
    ).toBe("noreply@email.ai-travelconcierge.com");
  });

  it("uses a full email_from_address as-is (legacy override)", () => {
    expect(
      resolveFromAddress({
        email_from_address: "support@acme.example",
        email_from_domain: null,
        email_from_domain_verified_at: null,
      }),
    ).toBe("support@acme.example");
  });

  it("combines verified domain + local-part address", () => {
    expect(
      resolveFromAddress({
        email_from_address: "support",
        email_from_domain: "acme.example",
        email_from_domain_verified_at: "2026-05-27T00:00:00Z",
      }),
    ).toBe("support@acme.example");
  });

  it("uses noreply@<verified-domain> when no local part is configured", () => {
    expect(
      resolveFromAddress({
        email_from_address: null,
        email_from_domain: "acme.example",
        email_from_domain_verified_at: "2026-05-27T00:00:00Z",
      }),
    ).toBe("noreply@acme.example");
  });

  it("IGNORES an UNverified domain (defends against bounces)", () => {
    // Domain set but verified_at null — operator started verification but
    // DNS isn't confirmed. Sending under this domain would bounce.
    expect(
      resolveFromAddress({
        email_from_address: null,
        email_from_domain: "acme.example",
        email_from_domain_verified_at: null,
      }),
    ).toBe("noreply@email.ai-travelconcierge.com");
  });

  it("IGNORES an unverified domain even when local-part is set", () => {
    expect(
      resolveFromAddress({
        email_from_address: "support",
        email_from_domain: "acme.example",
        email_from_domain_verified_at: null,
      }),
    ).toBe("support"); // best-effort; will likely fail at send time but doesn't silently use a domain we haven't proven we own
  });

  it("full address takes precedence over verified domain (operator chose explicit)", () => {
    expect(
      resolveFromAddress({
        email_from_address: "ceo@notthe.acme",
        email_from_domain: "acme.example",
        email_from_domain_verified_at: "2026-05-27T00:00:00Z",
      }),
    ).toBe("ceo@notthe.acme");
  });
});
