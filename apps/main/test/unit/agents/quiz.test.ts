// Tests for the find-my-agent quiz scorer. Encodes the WHY behind each
// match: matching specific tags should produce a specific recommended
// agent. If a future change to AGENT_CATALOG.quizTags re-routes a
// destination, the test that breaks tells you which decision moved.

import { describe, it, expect } from "vitest";
import { pickAgentFromTags } from "@/lib/agents/quiz";

describe("pickAgentFromTags", () => {
  it("recommends Marcus for Caribbean-heavy tags (his territory)", () => {
    expect(pickAgentFromTags(["caribbean", "warm", "beach"])).toBe("marcus-cole");
  });

  it("recommends Marco for Mediterranean + food tags (his territory)", () => {
    expect(pickAgentFromTags(["mediterranean", "europe", "food"])).toBe(
      "marco-bellini",
    );
  });

  it("recommends Captain Dave for Alaska + adventure tags", () => {
    expect(pickAgentFromTags(["alaska", "wildlife", "adventure"])).toBe(
      "captain-dave",
    );
  });

  it("recommends Priya for luxury + premium tags", () => {
    expect(pickAgentFromTags(["luxury", "premium", "small-ship"])).toBe(
      "priya-sharma",
    );
  });

  it("recommends Maya for accessibility tags (her specialty exists precisely so other agents don't get matched here)", () => {
    expect(pickAgentFromTags(["accessible", "mobility", "inclusive"])).toBe(
      "maya-patel",
    );
  });

  it("recommends Jenny for family + kids tags", () => {
    expect(pickAgentFromTags(["family", "kids", "multigen"])).toBe(
      "jenny-hartwell",
    );
  });

  it("ties resolve in catalog order (Marcus is first; an all-zero score should not crash)", () => {
    // Empty selection = every agent scores 0 = tie. The deterministic
    // tiebreaker is "first agent in catalog order" — verified here so a
    // future shuffle of AGENT_CATALOG doesn't silently change the
    // recommendation given to undecided visitors.
    expect(pickAgentFromTags([])).toBe("marcus-cole");
  });

  it("ignores unknown tags rather than throwing (forward-compat if quiz form adds tags before catalog catches up)", () => {
    expect(pickAgentFromTags(["caribbean", "totally-made-up-tag"])).toBe(
      "marcus-cole",
    );
  });
});
