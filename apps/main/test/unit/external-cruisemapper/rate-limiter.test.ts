// BP36 §33.5 — rate limiter test.
//
// 5 concurrent acquires at 2 RPS must leave the fifth acquire waiting
// through the first 1.499 seconds — proving the token bucket genuinely
// throttles under concurrent load without consuming real suite time.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetRateLimiterForTests, getCruiseMapperRateLimiter } from "../../../src/lib/external/cruisemapper/rate-limiter";

const originalEnv = { ...process.env };
beforeEach(() => {
  vi.useFakeTimers();
  _resetRateLimiterForTests();
});
afterEach(() => {
  vi.useRealTimers();
  process.env = { ...originalEnv };
  _resetRateLimiterForTests();
});

describe("CruiseMapper token bucket", () => {
  it("throttles 5 concurrent acquires at 2 RPS", async () => {
    process.env.CRUISEMAPPER_DIY_RATE_LIMIT_RPS = "2";
    const limiter = getCruiseMapperRateLimiter();
    const acquires = Promise.all([
      limiter.acquire(),
      limiter.acquire(),
      limiter.acquire(),
      limiter.acquire(),
      limiter.acquire(),
    ]);
    let completed = false;
    void acquires.then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(1_499);
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(acquires).resolves.toHaveLength(5);
  });

  it("singleton survives across getCruiseMapperRateLimiter calls", () => {
    process.env.CRUISEMAPPER_DIY_RATE_LIMIT_RPS = "1";
    const a = getCruiseMapperRateLimiter();
    const b = getCruiseMapperRateLimiter();
    expect(a).toBe(b);
  });

  it("rebuilds the bucket if RPS env var changes", () => {
    process.env.CRUISEMAPPER_DIY_RATE_LIMIT_RPS = "1";
    const a = getCruiseMapperRateLimiter();
    process.env.CRUISEMAPPER_DIY_RATE_LIMIT_RPS = "5";
    const b = getCruiseMapperRateLimiter();
    expect(a).not.toBe(b);
  });
});
