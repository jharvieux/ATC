// BP34 §33.2 — MockPricingDataSource unit tests.

import { describe, expect, it } from "vitest";
import { MockPricingDataSource } from "../../../src/lib/pricing/mock-pricing-data-source";
import type { CachedPriceQuote, SailingKey } from "../../../src/lib/pricing/types";

const SAILING: SailingKey = {
  line: "RCL",
  ship: "symphony-of-the-seas",
  sailDate: "2026-08-15",
  departurePort: "MIA",
  durationNights: 7,
};

function seedQuote(over: Partial<CachedPriceQuote> = {}): CachedPriceQuote {
  return {
    key: SAILING,
    cabinPrices: { interior: { amount: 899, currency: "USD" } },
    fetchedAt: new Date("2026-05-01T00:00:00Z"),
    source: "apify",
    stalenessHours: 24,
    freshnessFlag: "fresh",
    ...over,
  };
}

describe("MockPricingDataSource", () => {
  it("returns hit when key matches seed", async () => {
    const mock = new MockPricingDataSource({ quotes: [seedQuote()] });
    const result = await mock.getCachedPrice(SAILING);
    expect(result.status).toBe("hit");
    if (result.status === "hit") {
      expect(result.quote.cabinPrices.interior?.amount).toBe(899);
    }
  });

  it("returns miss when no quote seeded", async () => {
    const mock = new MockPricingDataSource();
    const result = await mock.getCachedPrice(SAILING);
    expect(result.status).toBe("miss");
  });

  it("returns unsupported when line marked as such", async () => {
    const mock = new MockPricingDataSource({ unsupportedLines: ["RCL"] });
    const result = await mock.getCachedPrice(SAILING);
    expect(result.status).toBe("unsupported");
  });

  it("refreshTrackedSailings bumps fetchedAt on existing entries", async () => {
    const old = new Date("2025-01-01T00:00:00Z");
    const mock = new MockPricingDataSource({ quotes: [seedQuote({ fetchedAt: old })] });
    const result = await mock.refreshTrackedSailings([SAILING]);
    expect(result.sailings_refreshed).toBe(1);
    const after = await mock.getCachedPrice(SAILING);
    if (after.status === "hit") {
      expect(after.quote.fetchedAt.getTime()).toBeGreaterThan(old.getTime());
      expect(after.quote.freshnessFlag).toBe("fresh");
    }
  });
});
