// BP36 §33.5 — rate limiter test.
//
// 5 concurrent acquires at 2 RPS must take at least ~2s elapsed —
// proving the token bucket genuinely throttles under concurrent load.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetRateLimiterForTests, getCruiseMapperRateLimiter } from "../../../src/lib/external/cruisemapper/rate-limiter";

const originalEnv = { ...process.env };
beforeEach(() => { _resetRateLimiterForTests(); });
afterEach(() => { process.env = { ...originalEnv }; _resetRateLimiterForTests(); });

describe("CruiseMapper token bucket", () => {
  it("throttles 5 concurrent acquires at 2 RPS to ~2 seconds", async () => {
    process.env.CRUISEMAPPER_DIY_RATE_LIMIT_RPS = "2";
    const limiter = getCruiseMapperRateLimiter();
    const start = Date.now();
    await Promise.all([
      limiter.acquire(),
      limiter.acquire(),
      limiter.acquire(),
      limiter.acquire(),
      limiter.acquire(),
    ]);
    const elapsedMs = Date.now() - start;
    // 5 tokens at 2 RPS with initial burst of 2: tokens 1,2 immediate;
    // tokens 3,4,5 wait 500ms, 1000ms, 1500ms. Min ≈ 1500ms.
    expect(elapsedMs).toBeGreaterThanOrEqual(1400);
    // Upper bound (generous): 3.5s
    expect(elapsedMs).toBeLessThan(3500);
  }, 10000);

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
