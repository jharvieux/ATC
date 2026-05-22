// §22.4 — Main-app PII zero-tolerance detector tests.
// Why these matter: a missed SSN or credit card lands in the corpus and
// becomes a data breach. False positives quarantine legitimate content.

import { describe, it, expect } from "vitest";
import { detectZeroTolerancePII } from "@/lib/rag-ingest/pii-regex-prefilter";

describe("detectZeroTolerancePII — §22.4", () => {
  it("flags a valid SSN with dashes", () => {
    const out = detectZeroTolerancePII("Customer SSN is 123-45-6789 for verification.");
    expect(out.detected).toBe(true);
    expect(out.categories).toContain("ssn");
  });

  it("does NOT flag zip+4 form (different separator)", () => {
    const out = detectZeroTolerancePII("Address ZIP code is 12345-6789 ABC St.");
    expect(out.detected).toBe(false);
  });

  it("does NOT flag obviously fake SSN (000-area)", () => {
    const out = detectZeroTolerancePII("Test data: 000-12-3456 — placeholder.");
    expect(out.detected).toBe(false);
  });

  it("flags a Luhn-valid credit card", () => {
    // Visa test number, Luhn-valid.
    const out = detectZeroTolerancePII("Charged card 4111-1111-1111-1111 for the trip.");
    expect(out.detected).toBe(true);
    expect(out.categories).toContain("credit_card");
  });

  it("does NOT flag a 16-digit number that fails Luhn", () => {
    const out = detectZeroTolerancePII("Booking reference 1234567890123456 received.");
    expect(out.detected).toBe(false);
  });

  it("flags a US-style passport number", () => {
    const out = detectZeroTolerancePII("Passport on file: A12345678 expires 2030.");
    expect(out.detected).toBe(true);
    expect(out.categories).toContain("passport");
  });

  it("flags an MRZ (machine-readable zone) line", () => {
    const out = detectZeroTolerancePII("P<USADOE<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<");
    expect(out.detected).toBe(true);
    expect(out.categories).toContain("passport");
  });

  it("returns clean for normal travel prose", () => {
    const out = detectZeroTolerancePII(
      "Wonder of the Seas departs Miami on December 1st with 7-night Caribbean itinerary.",
    );
    expect(out.detected).toBe(false);
    expect(out.categories).toEqual([]);
  });
});
