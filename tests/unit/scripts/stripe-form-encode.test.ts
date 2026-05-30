// stripeFormEncode produces what Stripe's API actually expects.
// Failing tests here mean the canary's replay calls Stripe with garbage
// (form-encoding mistakes silently 400 instead of recording).

import { describe, it, expect } from "vitest";
import { stripeFormEncode } from "../../../scripts/lib/stripe-form-encode";

describe("stripeFormEncode", () => {
  it("flat scalars become key=value pairs joined by &", () => {
    expect(stripeFormEncode({ email: "a@b.com", name: "Test" })).toBe(
      "email=a%40b.com&name=Test",
    );
  });

  it("nested objects use bracketed key syntax (Stripe's documented convention)", () => {
    expect(
      stripeFormEncode({ metadata: { tenant_id: "t1", env: "test" } }),
    ).toBe("metadata%5Btenant_id%5D=t1&metadata%5Benv%5D=test");
  });

  it("arrays use zero-indexed bracket syntax (subscription items shape)", () => {
    expect(
      stripeFormEncode({
        customer: "cus_X",
        items: [{ price: "price_X" }, { price: "price_Y" }],
      }),
    ).toBe(
      "customer=cus_X&items%5B0%5D%5Bprice%5D=price_X&items%5B1%5D%5Bprice%5D=price_Y",
    );
  });

  it("skips null and undefined (Stripe rejects empty bracketed keys)", () => {
    expect(
      stripeFormEncode({ email: "a@b.com", name: null, phone: undefined }),
    ).toBe("email=a%40b.com");
  });

  it("non-string scalars are coerced (Stripe expects all values as strings on the wire)", () => {
    expect(stripeFormEncode({ unit_amount: 1000, livemode: false })).toBe(
      "unit_amount=1000&livemode=false",
    );
  });

  it("special characters in values get URL-encoded (spaces, plus, equals)", () => {
    expect(stripeFormEncode({ name: "a b+c=d" })).toBe("name=a%20b%2Bc%3Dd");
  });
});
