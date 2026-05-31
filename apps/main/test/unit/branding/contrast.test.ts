// §16.2 — WCAG AA contrast checker unit tests.

import { describe, it, expect } from "vitest";
import { checkContrast, contrastRatio } from "@/lib/branding/contrast";

describe("contrastRatio", () => {
  it("black vs white is 21:1 (maximum)", () => {
    const r = contrastRatio("#000000", "#ffffff");
    expect(r).not.toBeNull();
    expect(r!).toBeCloseTo(21, 0);
  });

  it("white vs white is 1:1 (minimum, same color)", () => {
    const r = contrastRatio("#ffffff", "#ffffff");
    expect(r).toBe(1);
  });

  it("returns null for malformed hex", () => {
    expect(contrastRatio("not-a-color", "#ffffff")).toBeNull();
    expect(contrastRatio("#ff", "#ffffff")).toBeNull();
  });

  it("symmetric — order of args does not change ratio", () => {
    const a = contrastRatio("#3b82f6", "#ffffff");
    const b = contrastRatio("#ffffff", "#3b82f6");
    expect(a).toBeCloseTo(b!, 5);
  });
});

describe("checkContrast WCAG AA thresholds", () => {
  it("black on white passes both normal and large", () => {
    const c = checkContrast("#000000", "#ffffff");
    expect(c).not.toBeNull();
    expect(c!.passes_aa_normal).toBe(true);
    expect(c!.passes_aa_large).toBe(true);
  });

  it("light gray on white fails normal AA", () => {
    const c = checkContrast("#cccccc", "#ffffff");
    expect(c).not.toBeNull();
    expect(c!.passes_aa_normal).toBe(false);
  });

  it("blue accent on white passes AA-large but fails AA-normal", () => {
    // #3b82f6 on white is ~3.68:1 — over the 3.0 AA-large threshold,
    // under the 4.5 AA-normal threshold. Pin both flags, not just the
    // ratio, so a regression in either threshold is caught.
    const c = checkContrast("#3b82f6", "#ffffff");
    expect(c).not.toBeNull();
    expect(c!.passes_aa_large).toBe(true);
    expect(c!.passes_aa_normal).toBe(false);
  });

  it("returns null on malformed hex", () => {
    expect(checkContrast("xxx", "#fff")).toBeNull();
  });
});
