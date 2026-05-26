// BP34 §33.2 — In-memory PricingDataSource for tests.
//
// Deterministic. Constructor accepts a seed array. Every test that needs
// a PricingDataSource without burning Apify credits uses this.

import type {
  CachedPriceLookup,
  CachedPriceQuote,
  PricingDataSource,
  RefreshResult,
  SailingKey,
  CruiseLineCode,
} from "./types";

function sailingKeyHash(k: SailingKey): string {
  return `${k.line}|${k.ship}|${k.sailDate}|${k.departurePort}|${k.durationNights}`;
}

export interface MockSeed {
  quotes?: CachedPriceQuote[];
  unsupportedLines?: CruiseLineCode[];
}

export class MockPricingDataSource implements PricingDataSource {
  private store = new Map<string, CachedPriceQuote>();
  private unsupported: Set<CruiseLineCode>;

  constructor(seed: MockSeed = {}) {
    this.unsupported = new Set(seed.unsupportedLines ?? []);
    for (const q of seed.quotes ?? []) {
      this.store.set(sailingKeyHash(q.key), q);
    }
  }

  // D-088: refreshGeneralPricing removed from PricingDataSource (Apify
  // is now tracked-sailings only; DIY scraper handles general pricing).
  // The mock implementation drops the method to match.

  async refreshTrackedSailings(sailings: SailingKey[]): Promise<RefreshResult> {
    let refreshed = 0;
    for (const s of sailings) {
      if (this.unsupported.has(s.line)) continue;
      // Bump fetchedAt on existing entries so freshness tests can verify a refresh ran.
      const existing = this.store.get(sailingKeyHash(s));
      if (existing) {
        const updated: CachedPriceQuote = { ...existing, fetchedAt: new Date(), stalenessHours: 0, freshnessFlag: "fresh" };
        this.store.set(sailingKeyHash(s), updated);
        refreshed += 1;
      }
    }
    return {
      sailings_refreshed: refreshed,
      sailings_failed: 0,
      actor_run_id: null,
      spend_usd: 0,
      partial: false,
    };
  }

  async getCachedPrice(key: SailingKey): Promise<CachedPriceLookup> {
    if (this.unsupported.has(key.line)) return { status: "unsupported" };
    const quote = this.store.get(sailingKeyHash(key));
    if (!quote) return { status: "miss" };
    return { status: "hit", quote };
  }

  // Test-only helpers
  seedQuote(q: CachedPriceQuote): void {
    this.store.set(sailingKeyHash(q.key), q);
  }
  clear(): void {
    this.store.clear();
  }
}
