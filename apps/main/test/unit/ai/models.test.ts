// #851 — central model config: the attempt-latest chain + circuit-breaker.
// These encode the "attempt latest, fall back on issues" policy and the
// "sticky but self-healing" breaker, isolated from the wrapper's heavy deps.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  resolveModelChain,
  attemptModelChain,
  _resetModelBreakerForTests,
  HAIKU_LATEST,
  HAIKU_PINNED,
  SONNET,
  OPUS_LATEST,
  OPUS_PINNED,
} from "@/lib/ai/models";

describe("resolveModelChain", () => {
  it("haiku ids → [latest alias, pinned fallback]", () => {
    expect(resolveModelChain(HAIKU_PINNED)).toEqual([HAIKU_LATEST, HAIKU_PINNED]);
    expect(resolveModelChain(HAIKU_LATEST)).toEqual([HAIKU_LATEST, HAIKU_PINNED]);
  });
  it("opus → [4.8 latest, 4.7 fallback]; a caller still passing 4-7 also gets the 4.8-first chain", () => {
    expect(resolveModelChain(OPUS_LATEST)).toEqual([OPUS_LATEST, OPUS_PINNED]);
    expect(resolveModelChain(OPUS_PINNED)).toEqual([OPUS_LATEST, OPUS_PINNED]);
  });
  it("sonnet → single-entry chain (undated = latest, can't retire-fail)", () => {
    expect(resolveModelChain(SONNET)).toEqual([SONNET]);
  });
  it("unknown id → itself (still callable, just no in-tier fallback)", () => {
    expect(resolveModelChain("claude-future-9")).toEqual(["claude-future-9"]);
  });
});

describe("attemptModelChain", () => {
  beforeEach(() => _resetModelBreakerForTests());

  it("uses the first (latest) model when it succeeds — no fallback", async () => {
    const attempt = vi.fn(async (m: string) => `ok:${m}`);
    const onFallback = vi.fn();
    const r = await attemptModelChain(["a", "b"], attempt, { onFallback });
    expect(r).toEqual({ result: "ok:a", model: "a" });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("falls back to the next model on error + reports both error and fallback", async () => {
    const attempt = vi.fn(async (m: string) => {
      if (m === "a") throw new Error("404 not_found");
      return `ok:${m}`;
    });
    const onFallback = vi.fn();
    const onError = vi.fn();
    const r = await attemptModelChain(["a", "b"], attempt, { onFallback, onError });
    expect(r).toEqual({ result: "ok:b", model: "b" });
    expect(onError).toHaveBeenCalledWith("a", expect.any(Error));
    expect(onFallback).toHaveBeenCalledWith("a", "b");
  });

  it("throws the last error only when EVERY model fails", async () => {
    const attempt = vi.fn(async (m: string) => {
      throw new Error(`fail:${m}`);
    });
    await expect(attemptModelChain(["a", "b"], attempt)).rejects.toThrow("fail:b");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("circuit-breaker: skips a recently-failed model on the next call (sticky), then self-heals", async () => {
    let t = 1000;
    const now = () => t;
    const attempt = vi.fn(async (m: string) => {
      if (m === "a" && t < 2000) throw new Error("a down");
      return `ok:${m}`;
    });

    // call 1: a fails → trips breaker → b serves
    const r1 = await attemptModelChain(["a", "b"], attempt, { now });
    expect(r1.model).toBe("b");
    expect(attempt).toHaveBeenCalledWith("a"); // a WAS tried

    attempt.mockClear();
    // call 2 (still in cooldown): a is SKIPPED (not retried), b serves directly
    const r2 = await attemptModelChain(["a", "b"], attempt, { now });
    expect(r2.model).toBe("b");
    expect(attempt).not.toHaveBeenCalledWith("a");

    // advance past cooldown + a is healthy → returns to latest automatically
    t = 100_000;
    attempt.mockClear();
    const r3 = await attemptModelChain(["a", "b"], attempt, { now });
    expect(r3.model).toBe("a");
  });

  it("never skips the LAST entry even if it's cooling down (stale breaker can't fail a call)", async () => {
    const t = 1000;
    const now = () => t;
    await expect(attemptModelChain(["a"], async () => { throw new Error("a down"); }, { now })).rejects.toThrow("a down");
    // a is now in cooldown, but it's the only/last option → still tried next call
    const r = await attemptModelChain(["a"], async (m) => `ok:${m}`, { now });
    expect(r.model).toBe("a");
  });
});
