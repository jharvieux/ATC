// #781 — normalize-string.ts unit tests.
// Verifies the canonical matching normalizer produces correct slugs
// and safe variants for the free-text → FK resolution pipeline.

import { describe, expect, it } from "vitest";
import { normalizeForMatch, safeVariants } from "@/lib/canonical/normalize-string";

describe("normalizeForMatch", () => {
  it("lowercases and trims", () => {
    expect(normalizeForMatch("  ROYAL CARIBBEAN  ")).toBe("royal caribbean");
  });

  it("strips diacritics", () => {
    expect(normalizeForMatch("Costa Crocière")).toBe("costa crociere");
  });

  it("strips punctuation and collapses resulting space", () => {
    expect(normalizeForMatch("Holland & America")).toBe("holland america");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeForMatch("Royal   Caribbean")).toBe("royal caribbean");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeForMatch("")).toBe("");
  });
});

describe("safeVariants", () => {
  it("always includes the original normalized form", () => {
    const result = safeVariants("royal caribbean");
    expect(result).toContain("royal caribbean");
  });

  it("strips leading 'the'", () => {
    const result = safeVariants("the norwegian cruise line");
    expect(result).toContain("norwegian cruise line");
  });

  it("strips trailing 'cruise line'", () => {
    const result = safeVariants("norwegian cruise line");
    expect(result).toContain("norwegian");
  });

  it("strips trailing 'cruises'", () => {
    const result = safeVariants("celebrity cruises");
    expect(result).toContain("celebrity");
  });

  it("strips trailing 'lines'", () => {
    const result = safeVariants("carnival lines");
    expect(result).toContain("carnival");
  });

  it("strips trailing 'cruise lines'", () => {
    const result = safeVariants("carnival cruise lines");
    expect(result).toContain("carnival");
  });

  it("does NOT strip short results (single char)", () => {
    // stripping 'cruise' from 'x cruise' would leave 'x' — length > 1 so it passes
    // stripping from a 1-char result is blocked
    const result = safeVariants("a cruise");
    // 'a' is stripped because length(1) > 1 is false — length must be > 1
    expect(result).not.toContain("a");
  });

  it("produces no duplicates", () => {
    const result = safeVariants("celebrity cruises");
    expect(new Set(result).size).toBe(result.length);
  });

  it("handles name with no suffix to strip", () => {
    const result = safeVariants("seabourn");
    expect(result).toEqual(["seabourn"]);
  });

  it("strips 'the' then suffix in sequence", () => {
    // "the carnival cruise lines" → strip "the" → "carnival cruise lines"
    // → strip "cruise lines" → "carnival"
    const result = safeVariants("the carnival cruise lines");
    expect(result).toContain("carnival cruise lines");
    expect(result).toContain("carnival");
  });
});
