// §24.5 — detectToneOverride deterministic phrase match.

import { describe, it, expect } from "vitest";
import { detectToneOverride } from "@/lib/chat/customer-tone-override";

describe("detectToneOverride", () => {
  it("bumps up on 'be more casual'", () => {
    expect(detectToneOverride("Be more casual please")).toEqual({ kind: "bump_up" });
  });

  it("bumps down on 'be more professional'", () => {
    expect(detectToneOverride("Be more professional, thanks")).toEqual({ kind: "bump_down" });
  });

  it("sets direct on 'cut the small talk'", () => {
    expect(detectToneOverride("Just cut the small talk and tell me the price")).toEqual({
      kind: "set_direct",
    });
  });

  it("sets direct on 'get to the point'", () => {
    expect(detectToneOverride("Get to the point already")).toEqual({ kind: "set_direct" });
  });

  it("returns null when nothing matches", () => {
    expect(detectToneOverride("Tell me about Alaska cruises")).toBeNull();
  });

  it("prioritises set_direct over bump_down when both phrases would match", () => {
    expect(detectToneOverride("Cut the small talk, be more professional")).toEqual({
      kind: "set_direct",
    });
  });
});
