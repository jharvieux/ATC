// WHY: this is the rag-side copy of mapWithConcurrency (#1787) — a separate
// compiled artifact from apps/main's (no shared runtime package), so it needs
// its own pin against drift. Full contract coverage lives in
// apps/main/test/unit/lib/async/with-concurrency.test.ts; this pins the
// properties rag callers depend on (order preservation for the
// tenant-chunk-counts index-zip, the bound, fail-loud limit guard).

import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "@/lib/async/with-concurrency";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapWithConcurrency (rag copy)", () => {
  it("preserves input order even when items complete out of order", async () => {
    const results = await mapWithConcurrency([30, 20, 10, 0], 4, async (ms, i) => {
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
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("throws on limit <= 0 instead of silently returning holes", async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(
      "limit must be >= 1",
    );
  });
});
