// BP24 — Per-sentence supervisor tests.
//
// Behaviour under test (contract):
//   1. A clean sentence returns hit=false with no hashed term.
//   2. A sentence containing a deny-list term returns hit=true plus a stable
//      hashed term (never the raw term — §24.5 rule).
//   3. Substring false positives (deny-list "ass" should not flag "class")
//      are suppressed by the word-boundary matcher inherited from tone-drift.
//   4. Empty deny-list short-circuits to hit=false.

import { describe, expect, it } from "vitest";
import { checkSentence } from "../../../src/lib/supervisor/per-sentence-check";
import { hashTerm } from "../../../src/lib/supervisor/checks/tone-drift";

describe("checkSentence", () => {
  it("returns hit=false on clean text", () => {
    const r = checkSentence("This is a perfectly innocuous sentence.", ["badword"]);
    expect(r.hit).toBe(false);
    expect(r.hashedTerm).toBeUndefined();
  });

  it("returns hit=true with hashed term on a deny-list match", () => {
    const r = checkSentence("Please don't say badword here.", ["badword"]);
    expect(r.hit).toBe(true);
    expect(r.hashedTerm).toBe(hashTerm("badword"));
  });

  it("never surfaces the raw matched term", () => {
    const r = checkSentence("This contains badword somewhere.", ["badword"]);
    expect(r.hit).toBe(true);
    expect(r.hashedTerm).toBeDefined();
    expect(JSON.stringify(r)).not.toContain("badword");
  });

  it("does not flag substring matches (word-boundary)", () => {
    // Classic "scunthorpe" / "class" false-positive guard.
    const r = checkSentence("We have a wonderful class scheduled.", ["ass"]);
    expect(r.hit).toBe(false);
  });

  it("short-circuits on empty deny-list", () => {
    const r = checkSentence("Anything goes when the list is empty.", []);
    expect(r.hit).toBe(false);
  });

  it("matches case-insensitively", () => {
    const r = checkSentence("BadWord at the start.", ["badword"]);
    expect(r.hit).toBe(true);
  });
});
