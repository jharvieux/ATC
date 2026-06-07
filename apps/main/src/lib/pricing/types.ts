// BP34 §33.2 — PricingDataSource interface + key types.
//
// Single source of truth for the adapter shape. Two implementations:
//   - ApifyPricingAdapter (default, calls real Apify when ENABLED + token)
//   - MockPricingDataSource (in-memory; every test that doesn't burn $$)

export type CabinClass = "interior" | "oceanview" | "balcony" | "mini_suite" | "suite";
export const ALL_CABIN_CLASSES: readonly CabinClass[] = [
  "interior",
  "oceanview",
  "balcony",
  "mini_suite",
  "suite",
] as const;

// Cruise-line short codes used across the routing table + cache keys.
export type CruiseLineCode =
  | "RCL" | "NCL" | "PCL" | "CEL" | "COS"
  | "CCL" | "HAL" | "MSC" | "DSY"
  // Premium / luxury / specialty lines — itinerary + RAG coverage only. No
  // sercul pricing actor (LINE_ROUTES = null); price refresh, if ever wired,
  // routes via the BCK aggregator fallback.
  | "VIK" | "OCE" | "WST" | "SIL" | "RSS" | "SBN" | "AZA" | "CUN" | "VVY" | "PNO"
  // Aggregator fallback (booking.com cruises) for uncovered lines.
  | "BCK";

// Region grouping for batched refresh (line × region × date-window).
export type RegionCode = "caribbean" | "alaska" | "mediterranean" | "europe_other" | "asia" | "other";

export interface SailingKey {
  line: CruiseLineCode;
  ship: string;          // canonical ship slug
  sailDate: string;      // ISO date
  departurePort: string; // IATA-like code
  durationNights: number;
}

export type FreshnessFlag = "fresh" | "stale" | "expired";

export interface CachedPriceQuote {
  key: SailingKey;
  cabinPrices: Partial<Record<CabinClass, { amount: number; currency: "USD" }>>;
  fetchedAt: Date;
  source: "apify" | "manual" | "host_adapter" | "diy_cruisemapper";
  stalenessHours: number;
  freshnessFlag: FreshnessFlag;
}

/**
 * Cache lookup outcome. The `'unsupported'` arm is distinct from `'miss'`
 * so callers don't retry uncoverable lines (§33.2 / §33.3 discipline point).
 */
export type CachedPriceLookup =
  | { status: "hit"; quote: CachedPriceQuote }
  | { status: "miss" }
  | { status: "unsupported" };

export interface RefreshResult {
  sailings_refreshed: number;
  sailings_failed: number;
  actor_run_id: string | null;
  spend_usd: number;
  /** True when a budget cap or kill switch halted the run early. */
  partial: boolean;
  reason?: string;
}

export interface PricingDataSource {
  // D-088: refreshGeneralPricing removed. General-pricing context for the AI
  // is now sourced from the DIY CruiseMapper scraper (free, no Apify spend).
  // Apify is reserved for tracked-sailings refresh per active price_watches
  // rows only. See MEMORY D-088 and reality-delta-supplement §33.4/§33.9.3
  // for the rationale.

  refreshTrackedSailings(sailings: SailingKey[]): Promise<RefreshResult>;

  getCachedPrice(key: SailingKey): Promise<CachedPriceLookup>;
}
