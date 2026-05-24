// BP39 §33.7.3 — display markup parser unit tests.

import { describe, expect, it } from "vitest";
import { parseDisplayMarkup } from "../../../src/lib/ai/parse-display-markup";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const HALLUCINATED = "99999999-9999-4999-8999-999999999999";

describe("parseDisplayMarkup", () => {
  it("handles output with zero markups", () => {
    const r = parseDisplayMarkup("Plain text reply.", [A, B]);
    expect(r.sanitizedOutput).toBe("Plain text reply.");
    expect(r.displayedAssetIds).toEqual([]);
    expect(r.droppedIds).toEqual([]);
  });

  it("preserves a valid markup verbatim", () => {
    const r = parseDisplayMarkup(`Here is deck 9. [[display_asset:${A}]] Enjoy.`, [A, B]);
    expect(r.sanitizedOutput).toContain(`[[display_asset:${A}]]`);
    expect(r.displayedAssetIds).toEqual([A]);
    expect(r.droppedIds).toEqual([]);
  });

  it("strips a hallucinated ID (not in available set)", () => {
    const r = parseDisplayMarkup(`Here is a chart. [[display_asset:${HALLUCINATED}]] Enjoy.`, [A, B]);
    expect(r.sanitizedOutput).not.toContain("display_asset");
    expect(r.displayedAssetIds).toEqual([]);
    expect(r.droppedIds).toContain(HALLUCINATED);
  });

  it("mixed valid + invalid: keeps valid, strips invalid", () => {
    const text = `Deck 9: [[display_asset:${A}]]. Also see: [[display_asset:${HALLUCINATED}]]. And: [[display_asset:${B}]].`;
    const r = parseDisplayMarkup(text, [A, B]);
    expect(r.sanitizedOutput).toContain(`[[display_asset:${A}]]`);
    expect(r.sanitizedOutput).toContain(`[[display_asset:${B}]]`);
    expect(r.sanitizedOutput).not.toContain(HALLUCINATED);
    expect(r.displayedAssetIds).toEqual([A, B]);
    expect(r.droppedIds).toEqual([HALLUCINATED]);
  });

  it("strips malformed (non-UUID) markup", () => {
    const r = parseDisplayMarkup("Deck 9: [[display_asset:not-a-uuid]] etc.", [A]);
    expect(r.sanitizedOutput).not.toContain("display_asset");
    expect(r.malformedIds).toContain("not-a-uuid");
    expect(r.displayedAssetIds).toEqual([]);
  });

  it("dedupes same valid ID emitted multiple times in displayedAssetIds", () => {
    const r = parseDisplayMarkup(`[[display_asset:${A}]] [[display_asset:${A}]]`, [A]);
    expect(r.displayedAssetIds).toEqual([A]); // listed once
    // But both markups stay in output (client renders each).
    expect((r.sanitizedOutput.match(/display_asset/g) ?? []).length).toBe(2);
  });

  it("is case-insensitive on the UUID", () => {
    const r = parseDisplayMarkup(`[[display_asset:${A.toUpperCase()}]]`, [A]);
    expect(r.displayedAssetIds).toEqual([A]);
  });
});
