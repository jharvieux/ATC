// contracts-canary was 400ing nightly (#1968): attaching pm_card_visa to the
// test customer materializes a distinct attached PaymentMethod with its own
// pm_... id, but the customer update then passed the literal "pm_card_visa"
// token as default_payment_method — Stripe resolves that token to the
// canonical (unattached) visa PM, not the one just attached, so it 400s.
// This pins that the id returned by the attach call — not the raw token —
// is what flows into the customer update.

import { describe, it, expect } from "vitest";
import { attachDefaultPaymentMethod } from "../../../scripts/record-contracts";

describe("attachDefaultPaymentMethod", () => {
  it("uses the attach response's id, not the pm_card_visa token, as default_payment_method", async () => {
    const calls: Array<{ method: string; endpoint: string; body?: Record<string, unknown> }> = [];
    const attachedPmId = "pm_1TtnFakeAttachedId";

    const fetchFn = async (
      method: string,
      endpoint: string,
      body?: Record<string, unknown>,
    ) => {
      calls.push({ method, endpoint, body });
      if (endpoint === "/v1/payment_methods/pm_card_visa/attach") {
        return { status: 200, body: { id: attachedPmId } };
      }
      return { status: 200, body: { id: "cus_test" } };
    };

    await attachDefaultPaymentMethod("cus_test", fetchFn);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      method: "POST",
      endpoint: "/v1/payment_methods/pm_card_visa/attach",
      body: { customer: "cus_test" },
    });

    const updateCall = calls[1];
    expect(updateCall?.endpoint).toBe("/v1/customers/cus_test");
    const defaultPm = (
      updateCall?.body as { invoice_settings: { default_payment_method: string } }
    ).invoice_settings.default_payment_method;

    expect(defaultPm).toBe(attachedPmId);
    expect(defaultPm).not.toBe("pm_card_visa");
  });
});
