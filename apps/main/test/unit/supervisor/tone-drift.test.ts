// Unit tests for tone_drift check — §10.2 lexical sub-check
// The slur deny-list is operator-managed. Tests use a stand-in word
// ("BANNED_WORD_FIXTURE") per the build prompt spec.
// A regression here means hateful content reaching customers undetected.

import { describe, it, expect } from "vitest";
import { checkToneDrift } from "@/lib/supervisor/checks/tone-drift";

const FIXTURE_WORD = "BANNED_WORD_FIXTURE";

describe("checkToneDrift — lexical sub-check", () => {
  it("returns critical when response contains a deny-list word", () => {
    const result = checkToneDrift({
      candidate_response: `This is a test response with ${FIXTURE_WORD} in it.`,
      slurDenyList: [FIXTURE_WORD],
    });
    expect(result.severity).toBe("critical");
    expect(result.check).toBe("tone_drift");
  });

  it("is case-insensitive", () => {
    const result = checkToneDrift({
      candidate_response: `Response with ${FIXTURE_WORD.toLowerCase()} here.`,
      slurDenyList: [FIXTURE_WORD],
    });
    expect(result.severity).toBe("critical");
  });

  it("passes when deny list is empty", () => {
    const result = checkToneDrift({
      candidate_response: `Safe response with no bad words.`,
      slurDenyList: [],
    });
    expect(result.severity).toBe("info");
  });

  it("passes when response does not contain any deny-list word", () => {
    const result = checkToneDrift({
      candidate_response: "Have a lovely cruise!",
      slurDenyList: [FIXTURE_WORD, "ANOTHER_BANNED"],
    });
    expect(result.severity).toBe("info");
  });

  it("flags on first matching word in a multi-word deny list", () => {
    const result = checkToneDrift({
      candidate_response: `ANOTHER_BANNED_WORD appears here.`,
      slurDenyList: [FIXTURE_WORD, "ANOTHER_BANNED_WORD"],
    });
    expect(result.severity).toBe("critical");
  });

  it("ignores empty strings in deny list (would match everything)", () => {
    const result = checkToneDrift({
      candidate_response: "Normal response.",
      slurDenyList: ["", FIXTURE_WORD],
    });
    expect(result.severity).toBe("info");
  });
});
