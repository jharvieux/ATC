// #902 — PLATFORM HELP CONTEXT builder, exercised against the REAL help docs
// (content/help/*.md): the builder's job is matching conversational messages
// to the shipped corpus, so synthetic fixtures would test the wrong thing.
// If a docs rewrite breaks these, the matching genuinely regressed for that
// phrasing — fix the scoring, not the test.

import { describe, it, expect } from "vitest";
import { buildHelpContextBlock } from "@/lib/chat/help-context";

const TIER = "byo_agency";

describe("buildHelpContextBlock (#902)", () => {
  it("platform how-to question → block with the matching doc and the don't-fabricate instruction", () => {
    const block = buildHelpContextBlock("How do I customize my branding colors and logo?", TIER);
    expect(block).not.toBeNull();
    expect(block).toContain("--- Platform doc: Branding ---");
    expect(block).toContain("never invent platform features");
  });

  it("travel question → null (no help content leaks into ordinary expertise turns)", () => {
    const block = buildHelpContextBlock(
      "What are some good Alaska sailings in July for a multigenerational group?",
      TIER,
    );
    expect(block).toBeNull();
  });

  it("tier gating: a byo tenant never sees sub-host docs", () => {
    const block = buildHelpContextBlock("Where do I find the quickstart guide?", "byo_research");
    expect(block).not.toBeNull();
    expect(block).toContain("Bring-Your-Own");
    expect(block).not.toContain("Sub-host");
  });

  it("caps at two docs", () => {
    const block = buildHelpContextBlock(
      "How do quotes, bookings, branding, personas, CRM and billing settings work?",
      TIER,
    );
    expect(block).not.toBeNull();
    const docCount = (block!.match(/--- Platform doc:/g) ?? []).length;
    expect(docCount).toBeLessThanOrEqual(2);
  });

  it("empty/stopword-only message → null", () => {
    expect(buildHelpContextBlock("how can you help", TIER)).toBeNull();
  });
});
