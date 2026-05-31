// dependency-ignore-watch pure logic.
//
// The load-bearing decision is isBlockerCleared: it must return false
// while upstream still caps below the blocked major (so we don't
// prematurely nudge an upgrade that breaks), and true the moment the
// declared peer range admits the blocked major (so the ignore can't rot
// silently). The real-world ranges from eslint-plugin-react and vitest
// at the time the watch was built are pinned here as regression anchors.

import { describe, it, expect } from "vitest";
import {
  isBlockerCleared,
  parseWatchConfig,
} from "../../../scripts/lib/dependency-ignore-watch";

describe("isBlockerCleared", () => {
  it("returns false when the peer range caps below the blocked major (eslint case)", () => {
    // eslint-plugin-react@7.37.5 actual range — caps at 9.7, no ESLint 10.
    const range = "^3 || ^4 || ^5 || ^6 || ^7 || ^8 || ^9.7";
    expect(isBlockerCleared(range, 10)).toBe(false);
  });

  it("returns true when the peer range admits the blocked major (vite case)", () => {
    // vitest@4.1.7 actual range — already declares vite 8 support.
    const range = "^6.0.0 || ^7.0.0 || ^8.0.0";
    expect(isBlockerCleared(range, 8)).toBe(true);
  });

  it("returns true for a range that only admits a later minor of the blocked major", () => {
    // A future eslint-plugin-react might land support as `^10.2.0` (not .0.0).
    // Range-intersection must still count this as admitting major 10.
    expect(isBlockerCleared("^9.7 || ^10.2.0", 10)).toBe(true);
  });

  it("returns false for empty / null / whitespace ranges", () => {
    expect(isBlockerCleared(undefined, 10)).toBe(false);
    expect(isBlockerCleared(null, 10)).toBe(false);
    expect(isBlockerCleared("", 10)).toBe(false);
    expect(isBlockerCleared("   ", 10)).toBe(false);
  });

  it("returns false (not throw) for an unparseable range string", () => {
    // Some packages put git URLs or workspace protocols in peer ranges.
    expect(isBlockerCleared("git+https://example.com/x.git", 10)).toBe(false);
    expect(isBlockerCleared("workspace:*", 10)).toBe(false);
  });
});

describe("parseWatchConfig", () => {
  const valid = JSON.stringify({
    watches: [
      { ignored: "eslint", blocked_major: 10, gated_by: "eslint-plugin-react", peer_key: "eslint", reason: "x", ref: "#373" },
    ],
  });

  it("parses a well-formed config", () => {
    const cfg = parseWatchConfig(valid);
    expect(cfg.watches).toHaveLength(1);
    expect(cfg.watches[0]).toMatchObject({ ignored: "eslint", blocked_major: 10 });
  });

  it("ignores the $comment key (it's not a watch)", () => {
    const withComment = JSON.stringify({
      $comment: "explanatory note",
      watches: [{ ignored: "vite", blocked_major: 8, gated_by: "vitest", peer_key: "vite", reason: "y", ref: "#330" }],
    });
    expect(parseWatchConfig(withComment).watches).toHaveLength(1);
  });

  it("throws when watches is missing or not an array", () => {
    expect(() => parseWatchConfig(JSON.stringify({}))).toThrow(/watches/);
    expect(() => parseWatchConfig(JSON.stringify({ watches: "nope" }))).toThrow(/watches/);
  });

  it("throws when blocked_major is not a positive integer", () => {
    const bad = JSON.stringify({
      watches: [{ ignored: "eslint", blocked_major: "10", gated_by: "x", peer_key: "eslint", reason: "r", ref: "#1" }],
    });
    expect(() => parseWatchConfig(bad)).toThrow(/blocked_major/);
  });

  it("throws when a required string field is empty", () => {
    const bad = JSON.stringify({
      watches: [{ ignored: "", blocked_major: 10, gated_by: "x", peer_key: "eslint", reason: "r", ref: "#1" }],
    });
    expect(() => parseWatchConfig(bad)).toThrow(/ignored/);
  });
});
