// §23.10.1 — QuoteEstimateExpiredEmail template render tests.
//
// Tests verify WHY the behavior matters:
//   - The "Request a fresh quote" CTA must only appear when customer_access_token
//     was set (i.e. the quote was sent and a token minted). Showing a broken link
//     is worse than showing no link.
//   - The cruise label in the subject / heading must be present when provided so
//     customers can identify which quote expired without opening the email body.

import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuoteEstimateExpiredEmail } from "@/emails/QuoteEstimateExpiredEmail";

const BASE_LAYOUT = {
  branding: { logo_url: null, primary_color: null, secondary_color: null, accent_color: null, slogan: null },
  tenant_legal_name: "Test Agency",
  tenant_business_address: "123 Main St",
  unsubscribe_url: "https://example.com/unsub",
} as const;

describe("QuoteEstimateExpiredEmail — §23.10.1", () => {
  it("renders the refresh CTA link when refresh_url is provided", () => {
    const html = renderToStaticMarkup(
      React.createElement(QuoteEstimateExpiredEmail, {
        layout: BASE_LAYOUT,
        customer_name: "Jane",
        cruise_label: "Norwegian — Bliss",
        refresh_url: "https://app.example.com/q/abc123",
        validity_days: 7,
      }),
    );
    expect(html).toContain("https://app.example.com/q/abc123");
    expect(html).toContain("Request a fresh quote");
    expect(html).not.toContain("Reply to this email");
  });

  it("renders the fallback contact-agent text when refresh_url is null", () => {
    const html = renderToStaticMarkup(
      React.createElement(QuoteEstimateExpiredEmail, {
        layout: BASE_LAYOUT,
        customer_name: "Bob",
        cruise_label: null,
        refresh_url: null,
        validity_days: 7,
      }),
    );
    expect(html).not.toContain("Request a fresh quote");
    expect(html).toContain("Reply to this email");
  });

  it("includes the cruise label in the heading when provided", () => {
    const html = renderToStaticMarkup(
      React.createElement(QuoteEstimateExpiredEmail, {
        layout: BASE_LAYOUT,
        customer_name: "Alice",
        cruise_label: "Royal Caribbean — Symphony",
        refresh_url: null,
        validity_days: 14,
      }),
    );
    expect(html).toContain("Royal Caribbean");
    expect(html).toContain("14-day window");
  });

  it("falls back to 'your cruise' in the heading when cruise_label is null", () => {
    const html = renderToStaticMarkup(
      React.createElement(QuoteEstimateExpiredEmail, {
        layout: BASE_LAYOUT,
        customer_name: "Carlos",
        cruise_label: null,
        refresh_url: null,
        validity_days: 7,
      }),
    );
    expect(html).toContain("your cruise");
  });
});
