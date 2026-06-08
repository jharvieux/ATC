// ConciergeMessage email template — the body is AI-drafted text; it must render
// as escaped text with http(s) URLs auto-linked, never interpreting markup.

import * as React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConciergeMessage } from "../../../src/emails/ConciergeMessage";

const base = {
  branding: { logo_url: null, primary_color: null, secondary_color: null, accent_color: null, slogan: null },
  tenant_legal_name: "Booking by AI Travel Concierge",
  tenant_business_address: "1 Test St",
  persona_name: "Marcus Cole",
  unsubscribe_url: "https://app.ai-travelconcierge.com/email/unsubscribe?token=concierge-message",
};

describe("ConciergeMessage", () => {
  it("auto-links http(s) URLs in the body", () => {
    const out = renderToStaticMarkup(
      <ConciergeMessage {...base} body={"Your deck plans:\nhttps://www.cruisemapper.com/deck17"} />,
    );
    expect(out).toContain('href="https://www.cruisemapper.com/deck17"');
    expect(out).toContain("Your deck plans:");
  });

  it("escapes HTML in the body — model output can't inject markup", () => {
    const out = renderToStaticMarkup(<ConciergeMessage {...base} body={"<script>alert(1)</script> hi"} />);
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("does NOT link a non-http(s) scheme (javascript:)", () => {
    const out = renderToStaticMarkup(<ConciergeMessage {...base} body={"click javascript:alert(1) now"} />);
    expect(out).not.toContain('href="javascript:');
  });

  it("renders the persona signature + the CAN-SPAM unsubscribe link", () => {
    const out = renderToStaticMarkup(<ConciergeMessage {...base} body={"hello"} />);
    expect(out).toContain("Marcus Cole");
    expect(out).toContain(base.unsubscribe_url);
  });
});
