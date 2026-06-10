// #906 — Help AI open-QA turns are now grounded in platform docs.
// Before this fix the persona prompt claimed to cite docs but received none;
// now buildHelpContextBlock is injected for session_type='help' turns.
//
// These tests verify the grounding behavior via buildHelpContextBlock directly
// (the route wires it into buildSystemPrompt which is separately tested).

import { describe, it, expect } from "vitest";
import { buildHelpContextBlock } from "@/lib/chat/help-context";

describe("buildHelpContextBlock — #906 help_ai grounding", () => {
  it("empty tierCode (help_ai sentinel) includes all docs regardless of tier", () => {
    // All help docs have explicit tier lists. Empty tierCode must match them.
    const block = buildHelpContextBlock("How does branding work?", "");
    expect(block).not.toBeNull();
    expect(block).toContain("--- Platform doc: Branding ---");
  });

  it("bug/feature flows: a structured-question message has no doc title hit → null", () => {
    // Bug/feature flows pass messages like "What were the steps?" which don't
    // name a platform feature — no grounding should fire for those turns.
    const block = buildHelpContextBlock("What were the exact steps to reproduce?", "");
    expect(block).toBeNull();
  });

  it("grounding block carries the don't-fabricate instruction", () => {
    const block = buildHelpContextBlock("How do I invite a team member?", "");
    expect(block).not.toBeNull();
    expect(block).toContain("never invent platform features");
  });
});
