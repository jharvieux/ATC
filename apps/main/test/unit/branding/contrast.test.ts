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

  it("blue accent on white passes large but may fail normal", () => {
    const c = checkContrast("#3b82f6", "#ffffff");
    expect(c).not.toBeNull();
    expect(c!.ratio).toBeGreaterThan(3.0);
  });

  it("returns null on malformed hex", () => {
    expect(checkContrast("xxx", "#fff")).toBeNull();
  });
});
