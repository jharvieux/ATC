// @vitest-environment jsdom
//
// #1681 — regression coverage for the admin pricing <input type="number">
// blanking bug fixed in #1657. The bug: money amounts were rendered into a
// number input via a currency formatter that emits "$120.00"; a number input
// silently rejects a non-numeric string and renders BLANK, so every price
// field showed empty. The fix renders a plain decimal string ("120.00") via
// fromCents(). These tests fail if the render path regresses to a currency
// string (leading "$", thousands separators) or drops the null→"" contract
// that lets a genuinely-empty amount stay editable rather than showing NaN.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

const mockAdminFetch = vi.fn();
vi.mock("@/lib/admin-fetch", () => ({
  adminFetch: (...args: unknown[]) => mockAdminFetch(...args),
}));

const AdminPricingPage = (await import("@/app/(admin)/admin/pricing/_client")).default;

// A base row with a null stored amount resolves its display value from the
// tier definition (knownCents fallback); an additional_seats row with a null
// amount has no fallback → must render as "" (the blanking-safe empty state).
function pricingData() {
  return {
    stripe_configured: true,
    seat_ladder: [],
    tiers: [{ code: "sub_starter", base_price_monthly_cents: 12000, base_price_annual_cents: 120000 }],
    price_map: [
      {
        tenant_type: "sub_host",
        tier: "starter",
        billing_period: "monthly",
        line_item: "base",
        stripe_price_id: "price_base",
        amount_cents: null, // resolved from tiers → 12000 → "120.00"
        currency: "USD",
      },
      {
        tenant_type: "sub_host",
        tier: "starter",
        billing_period: "monthly",
        line_item: "additional_seats",
        stripe_price_id: "price_seat",
        amount_cents: 2550, // → "25.50"
        currency: "USD",
      },
      {
        tenant_type: "sub_host",
        tier: "pro",
        billing_period: "monthly",
        line_item: "additional_seats",
        stripe_price_id: "price_seat_pro",
        amount_cents: null, // no base fallback → "" (blanking-safe)
        currency: "USD",
      },
    ],
  };
}

beforeEach(() => {
  mockAdminFetch.mockReset();
  mockAdminFetch.mockResolvedValue({ ok: true, json: async () => pricingData() });
});

afterEach(() => cleanup());

describe("AdminPricingPage — number-input blanking bug (#1681/#1657)", () => {
  it("renders stored cents as a plain decimal the number input accepts", async () => {
    render(<AdminPricingPage />);
    // The bug-fix value: 12000 cents shows as "120.00", NOT "$120.00" (which a
    // number input would reject and render blank).
    expect(await screen.findByDisplayValue("120.00")).toBeTruthy();
    expect(screen.getByDisplayValue("25.50")).toBeTruthy();
  });

  it("never emits a currency-formatted string into a number input", async () => {
    render(<AdminPricingPage />);
    await screen.findByDisplayValue("120.00");
    const inputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input.value).not.toContain("$");
      expect(input.value).not.toContain(",");
    }
  });

  it("renders a null amount with no fallback as empty, not NaN or a currency string", async () => {
    render(<AdminPricingPage />);
    await screen.findByDisplayValue("120.00");
    const values = (screen.getAllByRole("spinbutton") as HTMLInputElement[]).map((i) => i.value);
    // The pro additional_seats row (amount_cents: null, no base fallback).
    expect(values).toContain("");
    expect(values).not.toContain("NaN");
  });
});
