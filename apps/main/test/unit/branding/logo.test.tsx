// #672 — Logo a11y prop contract.

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Logo } from "@/components/branding/Logo";

describe("Logo decorative prop", () => {
  it("sets alt to brand name by default so screen readers announce it", () => {
    const html = renderToStaticMarkup(createElement(Logo));
    expect(html).toContain('alt="AI Travel Concierge"');
  });

  it("renders empty alt when decorative=true so screen readers skip it", () => {
    const html = renderToStaticMarkup(createElement(Logo, { decorative: true }));
    expect(html).not.toContain('alt="AI Travel Concierge"');
    expect(html).toContain('alt=""');
  });
});
