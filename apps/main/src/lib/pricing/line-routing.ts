// BP34 §33.3 — per-line routing table for the ApifyPricingAdapter.
//
// Five verified `sercul` actors enabled at launch. Four more (Carnival,
// HAL, MSC, Disney) feature-flagged off pending operator confirmation
// of their actor slugs. Lines with no actor route at all → getCachedPrice
// returns `{ status: 'unsupported' }` (Virgin, Viking, Oceania, Regent,
// Silversea, Seabourn).
//
// The aggregator fallback (`vulnv/booking-cruises-scraper`) is NOT
// auto-routed today — operator opts in per-line by adding an explicit
// route override. Documented in MEMORY D-070.

import type { CachedPriceQuote, CabinClass, CruiseLineCode, SailingKey } from "./types";
import { ALL_CABIN_CLASSES } from "./types";

export interface ActorInput {
  /** Apify expects per-actor input JSON; we pass the raw shape through. */
  [key: string]: unknown;
}

export interface LineRoute {
  cruiseLine: CruiseLineCode;
  actorId: string;
  /** Set to true when the actor slug is confirmed in the Apify store. */
  enabled: boolean;
  inputBuilder: (sailings: SailingKey[]) => ActorInput;
  outputMapper: (item: unknown) => Omit<CachedPriceQuote, "stalenessHours" | "freshnessFlag"> | null;
}

// ──────────────────────────────────────────────────────────────────────────
// Output-mapping helpers — actors return diverse shapes. The mapping is
// best-effort with validation: missing required fields → null (logged +
// skipped by the caller, not cached).
// ──────────────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function mapSerculItem(item: unknown, cruiseLine: CruiseLineCode): Omit<CachedPriceQuote, "stalenessHours" | "freshnessFlag"> | null {
  if (!isPlainObject(item)) return null;
  const ship = typeof item.ship === "string" ? item.ship : null;
  const sailDate = typeof item.sailDate === "string" ? item.sailDate : (typeof item.departureDate === "string" ? item.departureDate : null);
  const departurePort = typeof item.departurePort === "string" ? item.departurePort : (typeof item.embarkPort === "string" ? item.embarkPort : null);
  const durationNights = typeof item.durationNights === "number" ? item.durationNights : (typeof item.nights === "number" ? item.nights : null);
  if (!ship || !sailDate || !departurePort || durationNights == null) return null;

  // Cabin pricing — accept either a flat per-cabin object OR a list with
  // `cabinClass` + `price` shape.
  const cabinPrices: Partial<Record<CabinClass, { amount: number; currency: "USD" }>> = {};
  const cabinSource = isPlainObject(item.cabinPrices) ? item.cabinPrices : null;
  if (cabinSource) {
    for (const cc of ALL_CABIN_CLASSES) {
      const raw = cabinSource[cc];
      if (isPlainObject(raw) && typeof raw.amount === "number" && raw.amount > 0) {
        cabinPrices[cc] = { amount: raw.amount, currency: "USD" };
      }
    }
  } else if (Array.isArray(item.cabins)) {
    for (const c of item.cabins) {
      if (!isPlainObject(c)) continue;
      const cc = typeof c.cabinClass === "string" ? (c.cabinClass as CabinClass) : null;
      const amt = typeof c.price === "number" ? c.price : null;
      if (cc && amt != null && amt > 0 && ALL_CABIN_CLASSES.includes(cc)) {
        cabinPrices[cc] = { amount: amt, currency: "USD" };
      }
    }
  }
  if (Object.keys(cabinPrices).length === 0) return null;

  return {
    key: {
      line: cruiseLine,
      ship,
      sailDate,
      departurePort,
      durationNights,
    },
    cabinPrices,
    fetchedAt: new Date(),
    source: "apify",
  };
}

function buildSerculInput(sailings: SailingKey[]): ActorInput {
  // Bucket by (ship, sailDate-month, departurePort) so actor input is compact.
  // Actors generally accept a list of search criteria.
  return {
    market: "US",
    sailings: sailings.map((s) => ({
      ship: s.ship,
      sailDate: s.sailDate,
      departurePort: s.departurePort,
      durationNights: s.durationNights,
    })),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Route table
// ──────────────────────────────────────────────────────────────────────────

export const LINE_ROUTES: Readonly<Record<CruiseLineCode, LineRoute | null>> = Object.freeze({
  RCL: { cruiseLine: "RCL", actorId: "sercul/royal-caribbean",         enabled: true,  inputBuilder: buildSerculInput, outputMapper: (i) => mapSerculItem(i, "RCL") },
  NCL: { cruiseLine: "NCL", actorId: "sercul/norwegian-cruise-scraper", enabled: true,  inputBuilder: buildSerculInput, outputMapper: (i) => mapSerculItem(i, "NCL") },
  PCL: { cruiseLine: "PCL", actorId: "sercul/princess-cruise-scraper",  enabled: true,  inputBuilder: buildSerculInput, outputMapper: (i) => mapSerculItem(i, "PCL") },
  CEL: { cruiseLine: "CEL", actorId: "sercul/celebrity-cruises",        enabled: true,  inputBuilder: buildSerculInput, outputMapper: (i) => mapSerculItem(i, "CEL") },
  COS: { cruiseLine: "COS", actorId: "sercul/costa-cruises",            enabled: true,  inputBuilder: buildSerculInput, outputMapper: (i) => mapSerculItem(i, "COS") },
  // Feature-flagged OFF pending actor-slug confirmation. Enable by
  // changing `enabled: true` after operator verifies the slug.
  CCL: { cruiseLine: "CCL", actorId: "TBC/carnival-cruises",            enabled: false, inputBuilder: buildSerculInput, outputMapper: (i) => mapSerculItem(i, "CCL") },
  HAL: { cruiseLine: "HAL", actorId: "TBC/holland-america",             enabled: false, inputBuilder: buildSerculInput, outputMapper: (i) => mapSerculItem(i, "HAL") },
  MSC: { cruiseLine: "MSC", actorId: "TBC/msc-cruises",                 enabled: false, inputBuilder: buildSerculInput, outputMapper: (i) => mapSerculItem(i, "MSC") },
  DSY: { cruiseLine: "DSY", actorId: "TBC/disney-cruise-line",          enabled: false, inputBuilder: buildSerculInput, outputMapper: (i) => mapSerculItem(i, "DSY") },
  // Aggregator fallback — NOT auto-routed. Operator opts in by writing a
  // dedicated LineRoute when ready.
  BCK: null,
});

/** Return the route for a line, or null if no actor covers it (unsupported). */
export function routeFor(line: CruiseLineCode): LineRoute | null {
  const r = LINE_ROUTES[line];
  return r && r.enabled ? r : null;
}

/** Cost-control batching: group sailings into 30-day windows per (line, port). */
export function groupSailingsForBatch(
  sailings: SailingKey[],
): Array<{ line: CruiseLineCode; sailings: SailingKey[] }> {
  const buckets = new Map<string, { line: CruiseLineCode; sailings: SailingKey[] }>();
  for (const s of sailings) {
    const monthBucket = s.sailDate.slice(0, 7); // YYYY-MM
    const bucketKey = `${s.line}|${s.departurePort}|${monthBucket}`;
    let entry = buckets.get(bucketKey);
    if (!entry) {
      entry = { line: s.line, sailings: [] };
      buckets.set(bucketKey, entry);
    }
    entry.sailings.push(s);
  }
  return [...buckets.values()];
}
