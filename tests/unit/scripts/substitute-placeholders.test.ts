// substitutePlaceholders is the load-bearing piece that makes the
// dependent-resource Stripe recording session work. A subscription fixture
// references "cus_test_placeholder"; this swaps it for the real
// "cus_REAL..." captured one step earlier in the same recording session.

import { describe, it, expect } from "vitest";
import { substitutePlaceholders } from "../../../scripts/lib/substitute-placeholders";

const subs = {
  cus_test_placeholder: "cus_real123",
  price_test_placeholder: "price_real456",
  sub_test_placeholder: "sub_real789",
};

describe("substitutePlaceholders", () => {
  it("replaces a top-level string match", () => {
    expect(substitutePlaceholders("cus_test_placeholder", subs)).toBe("cus_real123");
  });

  it("leaves non-matching strings untouched", () => {
    expect(substitutePlaceholders("test@example.com", subs)).toBe("test@example.com");
  });

  it("substitutes inside nested object values (subscription.customer field)", () => {
    expect(
      substitutePlaceholders(
        { customer: "cus_test_placeholder", description: "first month" },
        subs,
      ),
    ).toEqual({ customer: "cus_real123", description: "first month" });
  });

  it("substitutes inside array elements (subscription.items[].price)", () => {
    expect(
      substitutePlaceholders(
        { items: [{ price: "price_test_placeholder" }, { price: "price_test_placeholder" }] },
        subs,
      ),
    ).toEqual({
      items: [{ price: "price_real456" }, { price: "price_real456" }],
    });
  });

  it("preserves non-string scalars (numbers, booleans, null)", () => {
    expect(
      substitutePlaceholders(
        { unit_amount: 1000, livemode: false, archived: null },
        subs,
      ),
    ).toEqual({ unit_amount: 1000, livemode: false, archived: null });
  });

  it("does NOT modify the input object (must be safe to call mid-recording-session)", () => {
    const input = { customer: "cus_test_placeholder", items: [{ price: "price_test_placeholder" }] };
    const before = JSON.stringify(input);
    substitutePlaceholders(input, subs);
    expect(JSON.stringify(input)).toBe(before);
  });
});
