// WHY: mapWithConcurrency (#1787) backs the parallelized N+1 fixes across
// both apps, including billing-adjacent Inngest jobs. Its contract — result
// order preserved under out-of-order completion, the concurrency bound
// actually enforced, rejection propagation, fail-loud on a nonsensical
// limit — must hold independently of any call site, or a refactor could
// silently reorder results (callers zip them back to inputs by index) or
// unbound the fan-out the helper exists to bound.
//
// apps/rag/src/lib/async/with-concurrency.ts is an identical copy (no
// shared runtime package between the apps); this test pins the contract
// for both.

import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "@/lib/async/with-concurrency";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapWithConcurrency", () => {
  it("preserves input order even when items complete out of order", async () => {
    // Earlier items sleep longer, so completion order is reversed vs input.
    const items = [30, 20, 10, 0];
    const results = await mapWithConcurrency(items, 4, async (ms, i) => {
      await sleep(ms);
      return i;
    });
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5);
      inFlight--;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    // And it genuinely ran concurrently (not serialized to 1).
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("propagates a rejection from any item", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("returns [] for an empty input without invoking fn", async () => {
    let called = false;
    const results = await mapWithConcurrency([], 5, async () => {
      called = true;
    });
    expect(results).toEqual([]);
    expect(called).toBe(false);
  });

  it("handles limit greater than items.length", async () => {
    const results = await mapWithConcurrency([1, 2], 50, async (n) => n * 2);
    expect(results).toEqual([2, 4]);
  });

  it("throws on limit <= 0 instead of silently returning holes", async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(
      "limit must be >= 1",
    );
  });
});
