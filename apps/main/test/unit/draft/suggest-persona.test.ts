// #904 / D-193 decision 4 — persona suggestion is a SUGGESTION: a wrong one
// silently degrades the draft, so ambiguity must yield null (TA picks).

import { describe, it, expect } from "vitest";
import { suggestPersona } from "@/lib/draft/suggest-persona";

describe("suggestPersona (#904)", () => {
  it("clear Alaska inquiry → Captain Dave", () => {
    const s = suggestPersona(
      "We want to see glaciers in Alaska next June — maybe Glacier Bay or the Inside Passage?",
    );
    expect(s?.slug).toBe("captain-dave");
  });

  it("luxury inquiry → Priya", () => {
    const s = suggestPersona(
      "Looking for an ultra-premium small-ship experience, Silversea or Seabourn level, suite with butler.",
    );
    expect(s?.slug).toBe("priya-sharma");
  });

  it("family inquiry → Jenny", () => {
    const s = suggestPersona(
      "Traveling with kids (4 and 9) plus grandparents — multigenerational trip, need good kids clubs.",
    );
    expect(s?.slug).toBe("jenny-hartwell");
  });

  it("accessibility inquiry → Maya", () => {
    const s = suggestPersona(
      "My mother uses a wheelchair — which ships have accessible cabins and realistic mobility excursions?",
    );
    expect(s?.slug).toBe("maya-patel");
  });

  it("ambiguous inquiry → null (no suggestion beats a wrong suggestion)", () => {
    expect(suggestPersona("Hi, what cruises do you have available next year?")).toBeNull();
  });

  it("a single weak term is not enough", () => {
    expect(suggestPersona("Do you book beach hotels?")).toBeNull();
  });

  it("empty input → null", () => {
    expect(suggestPersona("   ")).toBeNull();
  });
});
