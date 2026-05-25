// §25.1 / audit pass 2 Finding 1 — PII redaction tests.

import { describe, it, expect } from "vitest";
import { redactPii, hasPii, totalHits } from "@/lib/pii/redact";

describe("redactPii", () => {
  describe("SSN", () => {
    it("redacts a canonical SSN", () => {
      const { redacted, hits } = redactPii("My SSN is 123-45-6789, please help.");
      expect(redacted).toBe("My SSN is [REDACTED_SSN], please help.");
      expect(hits.ssn).toBe(1);
    });

    it("redacts SSNs separated by spaces or dots", () => {
      expect(redactPii("123 45 6789").redacted).toBe("[REDACTED_SSN]");
      expect(redactPii("123.45.6789").redacted).toBe("[REDACTED_SSN]");
    });

    it("does not match obviously bogus SSN sentinels", () => {
      // 000-, 666-, and 9NN- prefixes are explicitly excluded.
      expect(redactPii("000-12-3456").redacted).toBe("000-12-3456");
      expect(redactPii("666-12-3456").redacted).toBe("666-12-3456");
      expect(redactPii("900-12-3456").redacted).toBe("900-12-3456");
      expect(redactPii("123-00-3456").redacted).toBe("123-00-3456");
      expect(redactPii("123-45-0000").redacted).toBe("123-45-0000");
    });

    it("counts multiple SSNs", () => {
      const { hits } = redactPii("A 123-45-6789 and B 222-33-4444.");
      expect(hits.ssn).toBe(2);
    });
  });

  describe("Credit card", () => {
    it("redacts a Luhn-valid 16-digit card", () => {
      // 4111-1111-1111-1111 is a Visa test number that passes Luhn.
      const { redacted, hits } = redactPii("Card: 4111-1111-1111-1111 thanks");
      expect(redacted).toBe("Card: [REDACTED_CREDIT_CARD] thanks");
      expect(hits.credit_card).toBe(1);
    });

    it("redacts a Luhn-valid card with no separators", () => {
      expect(redactPii("4111111111111111").redacted).toBe("[REDACTED_CREDIT_CARD]");
    });

    it("does NOT redact a 16-digit string that fails Luhn", () => {
      // Random non-Luhn digits.
      expect(redactPii("1234567890123456").redacted).toBe("1234567890123456");
    });

    it("does NOT redact a 12-digit string (too short for CC)", () => {
      expect(redactPii("411111111111").redacted).toBe("411111111111");
    });
  });

  describe("IBAN", () => {
    it("redacts a plausible IBAN", () => {
      // DE89370400440532013000 is a common test IBAN.
      const { redacted, hits } = redactPii("Send to DE89370400440532013000 please.");
      expect(redacted).toBe("Send to [REDACTED_IBAN] please.");
      expect(hits.iban).toBe(1);
    });

    it("does NOT match strings without the 2-letter country prefix", () => {
      expect(redactPii("8937040044053201300012").redacted).toBe("8937040044053201300012");
    });
  });

  describe("Passport (context-sensitive)", () => {
    it("redacts when 'passport:' precedes the token", () => {
      const { redacted, hits } = redactPii("Passport: ABC123456 — booking ref Foo.");
      expect(redacted).toBe("Passport: [REDACTED_PASSPORT] — booking ref Foo.");
      expect(hits.passport).toBe(1);
    });

    it("redacts when 'passport number' phrasing is used", () => {
      const { redacted } = redactPii("My passport number is X1234567.");
      expect(redacted).toContain("[REDACTED_PASSPORT]");
    });

    it("redacts when 'is my passport' follows the token", () => {
      const { redacted } = redactPii("USA1234567 is my passport number.");
      expect(redacted).toContain("[REDACTED_PASSPORT]");
    });

    it("does NOT redact a bare 9-char alphanumeric without passport context", () => {
      // No "passport" word — leaves it alone.
      expect(redactPii("Booking ref ABC123XYZ").redacted).toBe("Booking ref ABC123XYZ");
    });
  });

  describe("non-PII", () => {
    it("leaves emails alone (intentional — see file header)", () => {
      expect(redactPii("Email me at bob@example.com").redacted).toBe(
        "Email me at bob@example.com",
      );
    });

    it("leaves phone numbers alone (intentional)", () => {
      expect(redactPii("Call (555) 123-4567 anytime").redacted).toBe(
        "Call (555) 123-4567 anytime",
      );
    });

    it("returns empty string unchanged", () => {
      expect(redactPii("").redacted).toBe("");
    });

    it("idempotent: a second redaction is a no-op", () => {
      const once = redactPii("SSN 123-45-6789").redacted;
      const twice = redactPii(once).redacted;
      expect(twice).toBe(once);
    });
  });

  describe("aggregate helpers", () => {
    it("hasPii returns true when any redaction would occur", () => {
      expect(hasPii("SSN 123-45-6789")).toBe(true);
      expect(hasPii("no sensitive data here")).toBe(false);
    });

    it("totalHits sums across kinds", () => {
      const { hits } = redactPii(
        "SSN 123-45-6789 and card 4111-1111-1111-1111 and IBAN DE89370400440532013000",
      );
      expect(totalHits(hits)).toBe(3);
    });
  });
});
