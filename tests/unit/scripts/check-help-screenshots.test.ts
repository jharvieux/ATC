// Unit tests for the help-screenshot drift gate.
//
// Intent encoded here: help-doc screenshots must stay regenerable. The gate
// exists so that (1) customers never see a broken image, (2) no image ships
// that `pnpm help:screenshots` can't reproduce (hand-placed one-offs rot the
// moment the UI changes), and (3) every image carries alt text because alt
// is the only part of the image the Help AI's RAG ingest and screen readers
// can see. Legacy [Screenshot: ...] placeholders warn without blocking so
// the gate could land before the backfill.

import { describe, it, expect } from "vitest";
import { scanHelpScreenshots, type ScanInput } from "../../../scripts/check-help-screenshots";

const DOC = (slug: string, body: string): string => `---\ntitle: X\nslug: ${slug}\norder: 1\n---\n\n${body}`;

function scan(overrides: Partial<ScanInput>): ReturnType<typeof scanHelpScreenshots> {
  return scanHelpScreenshots({
    docs: new Map([["03-branding.md", DOC("branding", "![Logo fields](/help/branding/logo-fields.png)")]]),
    images: new Set(["branding/logo-fields.png"]),
    shots: [{ doc: "branding", id: "logo-fields" }],
    ...overrides,
  });
}

describe("scanHelpScreenshots", () => {
  it("passes when doc reference, PNG, and manifest entry agree", () => {
    const r = scan({});
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("fails on a doc reference with no PNG on disk (broken image for customers)", () => {
    const r = scan({ images: new Set() });
    expect(r.errors.some((e) => e.includes("does not exist"))).toBe(true);
  });

  it("fails on empty alt text (RAG ingest + screen readers see nothing)", () => {
    const r = scan({
      docs: new Map([["03-branding.md", DOC("branding", "![](/help/branding/logo-fields.png)")]]),
    });
    expect(r.errors.some((e) => e.includes("empty alt text"))).toBe(true);
  });

  it("fails on an orphan PNG no doc references", () => {
    const r = scan({
      images: new Set(["branding/logo-fields.png", "branding/stale.png"]),
      shots: [
        { doc: "branding", id: "logo-fields" },
        { doc: "branding", id: "stale" },
      ],
    });
    expect(r.errors.some((e) => e.includes("orphan image") && e.includes("stale.png"))).toBe(true);
  });

  it("fails on a hand-placed PNG with no manifest entry (not regenerable)", () => {
    const r = scan({ shots: [] });
    expect(r.errors.some((e) => e.includes("hand-placed image"))).toBe(true);
    expect(r.errors.some((e) => e.includes("no entry in scripts/help-screenshots/manifest.ts"))).toBe(true);
  });

  it("fails on a manifest entry whose PNG was never captured", () => {
    const r = scan({
      shots: [
        { doc: "branding", id: "logo-fields" },
        { doc: "branding", id: "colors" },
      ],
    });
    expect(r.errors.some((e) => e.includes('shot "branding/colors.png" has no captured PNG'))).toBe(true);
  });

  it("fails on a manifest entry targeting a nonexistent doc slug", () => {
    const r = scan({
      images: new Set(["branding/logo-fields.png", "typo-slug/x.png"]),
      shots: [
        { doc: "branding", id: "logo-fields" },
        { doc: "typo-slug", id: "x" },
      ],
    });
    expect(r.errors.some((e) => e.includes('doc slug "typo-slug" which matches no help doc'))).toBe(true);
  });

  it("fails on a callout annotation without a number", () => {
    const r = scan({
      shots: [{ doc: "branding", id: "logo-fields", annotations: [{ type: "callout", selector: "#x" }] }],
    });
    expect(r.errors.some((e) => e.includes("callout annotation without `n`"))).toBe(true);
  });

  it("warns (does not fail) on legacy [Screenshot: ...] placeholders", () => {
    const r = scan({
      docs: new Map([
        ["03-branding.md", DOC("branding", "![Logo fields](/help/branding/logo-fields.png)")],
        ["04-personas.md", DOC("personas", "[Screenshot: persona cards]")],
      ]),
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes("unfilled placeholder"))).toBe(true);
  });

  it("ignores images outside /help/ (not this gate's jurisdiction)", () => {
    const r = scan({
      docs: new Map([["03-branding.md", DOC("branding", "![Logo fields](/help/branding/logo-fields.png)\n![ext](https://example.com/x.png)")]]),
    });
    expect(r.errors).toEqual([]);
  });
});
