// #975 — GroupReminder default template.
//
// Intent under test: the pre-#975 reminder was a bare HTML string with NO
// CAN-SPAM footer (legal name, address, unsubscribe). The redesigned default
// renders inside BrandedLayout, so the footer must be present — losing it
// again would be a compliance regression, not a styling change.

import { describe, it, expect } from "vitest";
import * as React from "react";
import * as ReactDOMServer from "react-dom/server";
import { GroupReminder } from "@/emails/GroupReminder";

const layout = {
  branding: {},
  tenant_legal_name: "Test Agency LLC",
  tenant_business_address: "123 Main St, Miami FL",
  unsubscribe_url: "https://x.example/unsub?token=abc",
};

function render(overrides: Partial<React.ComponentProps<typeof GroupReminder>> = {}): string {
  return ReactDOMServer.renderToStaticMarkup(
    React.createElement(GroupReminder, {
      layout,
      invitee_name: "Sam",
      cruise_line: "Carnival",
      ship_name: "Mardi Gras",
      sailing_date: "2026-11-03",
      coordinator_message: "Can't wait to sail with you all!",
      hero_image_url: null,
      ...overrides,
    }),
  );
}

describe("GroupReminder", () => {
  it("keeps the CAN-SPAM footer: legal name, address, unsubscribe link", () => {
    const html = render();
    expect(html).toContain("Test Agency LLC");
    expect(html).toContain("123 Main St, Miami FL");
    expect(html).toContain("https://x.example/unsub?token=abc");
  });

  it("renders the trip details and coordinator message", () => {
    const html = render();
    expect(html).toContain("Hi Sam!");
    expect(html).toContain("Carnival");
    expect(html).toContain("Mardi Gras");
    expect(html).toContain("sail with you all!");
  });

  it("falls back to a generic greeting and omits the empty coordinator quote", () => {
    const html = render({ invitee_name: null, coordinator_message: null });
    expect(html).toContain("Hi there!");
    expect(html).not.toContain("<blockquote");
  });

  it("renders the hero image when the group has one", () => {
    const html = render({ hero_image_url: "https://img.example/hero.jpg" });
    expect(html).toContain("https://img.example/hero.jpg");
  });
});
