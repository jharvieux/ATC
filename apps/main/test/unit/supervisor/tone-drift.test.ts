// Unit tests for tone_drift check — §10.2 lexical sub-check + §24.5 hash details.
// The slur deny-list is operator-managed. Tests use a stand-in word
// ("BANNED_WORD_FIXTURE") per the build prompt spec.
// A regression here means hateful content reaching customers undetected.
//
// The heuristic Haiku sub-check is exercised only by ensuring ANTHROPIC_API_KEY
// is unset, so it returns the "haiku_unavailable" path deterministically.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkToneDrift, hashTerm } from "@/lib/supervisor/checks/tone-drift";

const FIXTURE_WORD = "BANNED_WORD_FIXTURE";

describe("checkToneDrift — lexical sub-check", () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it("returns critical with hashed term details when response contains a deny-list word", async () => {
    const result = await checkToneDrift({
      candidate_response: `This is a test response with ${FIXTURE_WORD} in it.`,
      slurDenyList: [FIXTURE_WORD],
    });
    expect(result.severity).toBe("critical");
    expect(result.check).toBe("tone_drift");
    expect(result.details).toBe(`lexical_match:${hashTerm(FIXTURE_WORD)}`);
    expect(result.details).not.toContain(FIXTURE_WORD); // never leak the term
  });

  it("is case-insensitive", async () => {
    const result = await checkToneDrift({
      candidate_response: `Response with ${FIXTURE_WORD.toLowerCase()} here.`,
      slurDenyList: [FIXTURE_WORD],
    });
    expect(result.severity).toBe("critical");
  });

  it("passes when deny list is empty", async () => {
    const result = await checkToneDrift({
      candidate_response: `Safe response with no bad words.`,
      slurDenyList: [],
    });
    expect(result.severity).toBe("info");
  });

  it("passes when response does not contain any deny-list word", async () => {
    const result = await checkToneDrift({
      candidate_response: "Have a lovely cruise!",
      slurDenyList: [FIXTURE_WORD, "ANOTHER_BANNED"],
    });
    expect(result.severity).toBe("info");
  });

  it("flags on first matching word in a multi-word deny list", async () => {
    const result = await checkToneDrift({
      candidate_response: `ANOTHER_BANNED_WORD appears here.`,
      slurDenyList: [FIXTURE_WORD, "ANOTHER_BANNED_WORD"],
    });
    expect(result.severity).toBe("critical");
  });

  it("ignores empty strings in deny list (would match everything)", async () => {
    const result = await checkToneDrift({
      candidate_response: "Normal response.",
      slurDenyList: ["", FIXTURE_WORD],
    });
    expect(result.severity).toBe("info");
  });

  it("uses word-boundary matching (does not match substrings)", async () => {
    // "scunthorpe problem": the deny-list term is 'cunt' but the candidate
    // says 'Scunthorpe' (a real UK town). Word boundary should prevent match.
    const result = await checkToneDrift({
      candidate_response: "We can sail from Scunthorpe.",
      slurDenyList: ["cunt"],
    });
    expect(result.severity).toBe("info");
  });
});
