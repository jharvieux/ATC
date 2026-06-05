// #672 — Logo a11y prop contract. After #670 the component renders inline
// SVG instead of <img>, so the announce/skip contract is expressed via
// role + aria-label (announce) vs aria-hidden (skip), not alt-text.
//
// The invariant matters because Logo is the brand mark in SiteHeader; an
// adjacent hero heading already names the brand visually, and if the SVG
// also announces "AI Travel Concierge" the screen reader reads the brand
// twice. The decorative=true path is the SR-skip escape hatch.

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Logo } from "@/components/branding/Logo";

describe("Logo decorative prop", () => {
  it("announces the brand via role=img + aria-label by default", () => {
    const html = renderToStaticMarkup(createElement(Logo));
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="AI Travel Concierge"');
    expect(html).not.toContain("aria-hidden");
  });

  it("hides the SVG from screen readers when decorative=true", () => {
    const html = renderToStaticMarkup(createElement(Logo, { decorative: true }));
    expect(html).toContain("aria-hidden");
    expect(html).not.toContain('aria-label="AI Travel Concierge"');
    expect(html).not.toContain('role="img"');
  });
});
