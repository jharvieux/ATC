// §9.3 — Anthropic prompt caching gate. buildSystemArg wraps a plain
// system-prompt string into the structured block array shape Anthropic
// requires for cache_control markers. Gated by env so operators can
// flip caching off for A/B or debugging without a redeploy.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildSystemArg } from "@/lib/ai/call-wrapper";

describe("buildSystemArg (§9.3 Anthropic prompt cache gate)", () => {
  const original = process.env.ANTHROPIC_PROMPT_CACHE_ENABLED;
  beforeEach(() => {
    delete process.env.ANTHROPIC_PROMPT_CACHE_ENABLED;
  });
  afterEach(() => {
    if (original !== undefined) process.env.ANTHROPIC_PROMPT_CACHE_ENABLED = original;
    else delete process.env.ANTHROPIC_PROMPT_CACHE_ENABLED;
  });

  it("returns undefined when the caller passed no system prompt", () => {
    expect(buildSystemArg(undefined)).toBeUndefined();
    expect(buildSystemArg("")).toBeUndefined();
  });

  it("returns a cache_control-marked block when env is unset (default true)", () => {
    const r = buildSystemArg("you are an assistant");
    expect(r).toEqual([
      { type: "text", text: "you are an assistant", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("returns a cache_control-marked block when env is 'true'", () => {
    process.env.ANTHROPIC_PROMPT_CACHE_ENABLED = "true";
    const r = buildSystemArg("hello") as Array<{ cache_control?: unknown }>;
    expect(Array.isArray(r)).toBe(true);
    expect(r[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("returns the plain string when env is 'false' (caching off)", () => {
    process.env.ANTHROPIC_PROMPT_CACHE_ENABLED = "false";
    expect(buildSystemArg("hello")).toBe("hello");
  });

  it("treats any non-'false' value as enabled (defensive — typo'd env shouldn't silently disable)", () => {
    process.env.ANTHROPIC_PROMPT_CACHE_ENABLED = "yes";
    const r = buildSystemArg("hello") as Array<{ cache_control?: unknown }>;
    expect(Array.isArray(r)).toBe(true);
    expect(r[0]?.cache_control).toEqual({ type: "ephemeral" });
  });
});
