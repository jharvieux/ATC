// §20.6 — Booking validation layer tests.

import { describe, it, expect } from "vitest";
import {
  validateEmail,
  validatePassportExpiry,
  validateDOBSanity,
  validatePricingMath,
  validatePassengersForSubmission,
} from "@/lib/booking/validation";

describe("validateEmail", () => {
  it("accepts valid email", () => {
    expect(validateEmail("alice@example.com")).toBeNull();
  });

  it("rejects email without @", () => {
    expect(validateEmail("aliceexample.com")).not.toBeNull();
  });

  it("rejects email without domain", () => {
    expect(validateEmail("alice@")).not.toBeNull();
  });
});

describe("validatePassportExpiry — §20.6 (6 months after sailing)", () => {
  const sailing = new Date("2026-06-15");

  it("passes when passport expires 7 months after sailing", () => {
    const expiry = new Date("2027-01-15");
    expect(validatePassportExpiry(expiry, sailing)).toBeNull();
  });

  it("fails when passport expires 5 months after sailing", () => {
    const expiry = new Date("2026-11-14");
    expect(validatePassportExpiry(expiry, sailing)).not.toBeNull();
  });

  it("passes when expiry is null (no passport entered yet)", () => {
    expect(validatePassportExpiry(null, sailing)).toBeNull();
  });
});

describe("validateDOBSanity", () => {
  const sailing = new Date("2026-06-15");

  it("passes for a 30-year-old", () => {
    const dob = new Date("1996-06-15");
    expect(validateDOBSanity(dob, sailing)).toBeNull();
  });

  it("fails for a future DOB", () => {
    const dob = new Date("2027-01-01");
    expect(validateDOBSanity(dob, sailing)).not.toBeNull();
  });

  it("fails for an implausibly old DOB (> 120 years)", () => {
    const dob = new Date("1900-01-01");
    expect(validateDOBSanity(dob, sailing)).not.toBeNull();
  });
});

describe("validatePricingMath", () => {
  it("passes when subtotal + options = total", () => {
    expect(validatePricingMath(10000, [2000, 3000], 15000)).toBeNull();
  });

  it("fails when totals don't match", () => {
    expect(validatePricingMath(10000, [2000, 3000], 16000)).not.toBeNull();
  });

  it("passes with no options (simple case)", () => {
    expect(validatePricingMath(10000, [], 10000)).toBeNull();
  });
});

describe("validatePassengersForSubmission", () => {
  const sailing = new Date("2026-06-15");

  it("fails with no passengers", () => {
    const errors = validatePassengersForSubmission([], sailing);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("passes for valid passenger", () => {
    const errors = validatePassengersForSubmission(
      [{ legal_first_name: "Alice", legal_last_name: "Smith", date_of_birth: new Date("1990-01-01") }],
      sailing,
    );
    expect(errors).toHaveLength(0);
  });

  it("fails if passenger DOB is in the future", () => {
    const errors = validatePassengersForSubmission(
      [{ legal_first_name: "Alice", legal_last_name: "Smith", date_of_birth: new Date("2030-01-01") }],
      sailing,
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});
