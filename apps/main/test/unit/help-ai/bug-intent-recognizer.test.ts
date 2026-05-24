// BP32 §32.10.1 — bug-intent recognizer.

import { describe, it, expect } from "vitest";
import { matchesAnySeedPhrase, OFFER_MESSAGE } from "@/lib/help-ai/bug-intent-recognizer";

describe("matchesAnySeedPhrase", () => {
  it("matches 'this is broken' anywhere in the message", () => {
    expect(matchesAnySeedPhrase("hey, this is broken on the search page")).toBe("this is broken");
  });

  it("matches case-insensitively", () => {
    expect(matchesAnySeedPhrase("THIS IS BROKEN")).toBe("this is broken");
  });

  it("matches 'i think there's a bug'", () => {
    expect(matchesAnySeedPhrase("I think there's a bug with the date picker")).toBe("i think there's a bug");
  });

  it("matches the contraction-free variant 'i think there is a bug'", () => {
    expect(matchesAnySeedPhrase("I think there is a bug")).toBe("i think there is a bug");
  });

  it("matches 'the website crashed'", () => {
    expect(matchesAnySeedPhrase("Hi, the website crashed when I clicked submit")).toBe("the website crashed");
  });

  it("returns null for messages without trigger phrases", () => {
    expect(matchesAnySeedPhrase("Hi, can you help me find a cruise to Alaska?")).toBe(null);
  });

  it("OFFER_MESSAGE is the §32.10.1 verbatim text", () => {
    expect(OFFER_MESSAGE).toMatch(/sounds like something might not be working/i);
    expect(OFFER_MESSAGE).toMatch(/file a bug report/i);
    expect(OFFER_MESSAGE).toMatch(/engineering team/i);
  });
});
