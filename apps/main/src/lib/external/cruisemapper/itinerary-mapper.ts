// BP35 §33.4 — CruiseMapper itinerary normalization.
//
// One actor item → up to two outputs:
//   1. A CachedPriceQuote-shaped record for pricing_cache (only when the
//      actor included a starting price for the interior cabin).
//   2. A structured text doc for RAG ingest: dense, factual prose at the
//      §B.5 ~500-token target. The RAG service hashes the text for
//      content-hash idempotency, so the prose shape must be deterministic.

import type { CachedPriceQuote, SailingKey } from "@/lib/pricing/types";
import type { ParsedSailing, ParsedSailingDay } from "./parsers/sailing-parser";
import type { SailingListItem } from "./parsers/sailing-list-parser";

export interface CruiseMapperItineraryItem {
  cruiseLine?: unknown;
  ship?: unknown;
  departureDate?: unknown;       // ISO YYYY-MM-DD
  departurePort?: unknown;
  durationNights?: unknown;      // number
  portsOfCall?: unknown;         // string[]
  region?: unknown;              // optional category
  startingPriceUsd?: unknown;    // optional, interior cabin
  sourceUrl?: unknown;
}

export interface MappedItinerary {
  /** Composite key. */
  key: SailingKey;
  /** Set when the actor included a starting interior price. */
  cacheQuote: Omit<CachedPriceQuote, "stalenessHours" | "freshnessFlag"> | null;
  /** Prose for RAG ingest (deterministic given the same input). */
  text: string;
  /** Optional RAG-side fields. */
  region: string | null;
  portsOfCall: string[];
  startingPriceUsd: number | null;
  sourceUrl: string | null;
  /** Full day-by-day itinerary from the DIY sailing parser; null for Apify-sourced records. */
  dayByDay: ParsedSailingDay[] | null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

// Short codes that may arrive already-normalized (internal callers).
const KNOWN_CODES = new Set<string>([
  "RCL", "NCL", "PCL", "CEL", "COS", "CCL", "HAL", "MSC", "DSY",
  "VIK", "OCE", "WST", "SIL", "RSS", "SBN", "AZA", "CUN", "VVY", "PNO", "BCK",
]);

// Substring rules, first match wins — list more specific fragments first. These
// match the cruise-line labels CruiseMapper emits, including parenthetical
// sub-brands ("Galapagos (Celebrity Cruises)", "MSC Explora Journeys",
// "Viking Ocean (Viking Cruises)", "Avora Residences (Regent Seven Seas...)").
// Substring matching is safe here: the input is always a cruise-line label,
// never a ship or port name.
const LINE_RULES: ReadonlyArray<readonly [string, SailingKey["line"]]> = [
  ["ROYAL CARIBBEAN", "RCL"],
  ["CELEBRITY", "CEL"],
  ["CARNIVAL", "CCL"],
  ["NORWEGIAN", "NCL"],
  ["PRINCESS", "PCL"],
  ["HOLLAND AMERICA", "HAL"],
  ["DISNEY", "DSY"],
  ["COSTA", "COS"],
  ["MSC", "MSC"],
  ["VIKING", "VIK"],
  ["OCEANIA", "OCE"],
  ["WINDSTAR", "WST"],
  ["SILVERSEA", "SIL"],
  ["REGENT", "RSS"],
  ["SEABOURN", "SBN"],
  ["AZAMARA", "AZA"],
  ["CUNARD", "CUN"],
  ["VIRGIN", "VVY"],
  ["P&O", "PNO"],
];

// Normalize a cruise-line label to a SailingKey.line code. Returns null ONLY for
// an empty label; any other unrecognized line falls back to BCK (the aggregator
// code) so its itinerary is never silently dropped. The 2026-06-06 gap was ~117
// ships on lines the old hard allow-list returned null for — mapSailing dropped
// them and the content_hash masking bug hid it.
export function normalizeLineCode(raw: string): SailingKey["line"] | null {
  const upper = raw.toUpperCase().trim();
  if (upper.length === 0) return null;
  if (KNOWN_CODES.has(upper)) return upper as SailingKey["line"];
  for (const [needle, code] of LINE_RULES) {
    if (upper.includes(needle)) return code;
  }
  return "BCK";
}

/**
 * Render the dense prose RAG chunk for one itinerary. Determinism matters
 * — same input must produce identical text so the SHA-256 content hash
 * short-circuits unchanged re-ingests.
 */
function renderText(line: SailingKey["line"], lineLabel: string, ship: string, departureDate: string, departurePort: string, durationNights: number, ports: string[], region: string | null, startingPrice: number | null): string {
  const portsClause = ports.length > 0 ? ` visiting ${ports.join(", ")}` : "";
  const regionClause = region ? ` (${region})` : "";
  const priceClause = startingPrice != null ? ` Starting price $${startingPrice.toFixed(0)}.` : "";
  // Note: we keep the original long-form line label in the prose so the
  // chunk is human-readable. The composite key in the cache still uses
  // the canonical short code.
  return `${lineLabel}'s ${ship} departs ${departurePort} on ${departureDate} for a ${durationNights}-night cruise${regionClause}${portsClause}.${priceClause} Cruise line code: ${line}.`;
}

/** Map one raw actor item; returns null when required fields are missing. */
export function mapItinerary(item: CruiseMapperItineraryItem): MappedItinerary | null {
  const lineLabel = asString(item.cruiseLine);
  const ship = asString(item.ship);
  const departureDate = asString(item.departureDate);
  const departurePort = asString(item.departurePort);
  const durationNights = asNumber(item.durationNights);
  if (!lineLabel || !ship || !departureDate || !departurePort || durationNights == null || durationNights <= 0) {
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(departureDate)) return null;

  const line = normalizeLineCode(lineLabel);
  if (!line) return null;

  const ports = asStringArray(item.portsOfCall);
  const region = asString(item.region);
  const startingPrice = asNumber(item.startingPriceUsd);
  const sourceUrl = asString(item.sourceUrl);

  const key: SailingKey = {
    line,
    ship,
    sailDate: departureDate,
    departurePort,
    durationNights,
  };

  const text = renderText(line, lineLabel, ship, departureDate, departurePort, durationNights, ports, region, startingPrice);

  // Cache quote: only when we have an actual interior price. The §33.3
  // validation band ($50-$50,000) is enforced at the cache layer; we keep
  // the mapper permissive and let the cache reject out-of-band values.
  const cacheQuote = startingPrice != null && startingPrice > 0
    ? {
        key,
        cabinPrices: { interior: { amount: startingPrice, currency: "USD" as const } },
        fetchedAt: new Date(),
        source: "apify" as const,
      }
    : null;

  return {
    key,
    cacheQuote,
    text,
    region,
    portsOfCall: ports,
    startingPriceUsd: startingPrice,
    sourceUrl,
    dayByDay: null,
  };
}

/**
 * Map a DIY-parsed current sailing to MappedItinerary. Returns null only when
 * the cruise line is empty; an unrecognized (non-empty) line falls back to BCK
 * via normalizeLineCode rather than being dropped.
 */
export function mapSailing(s: ParsedSailing): MappedItinerary | null {
  const line = normalizeLineCode(s.cruise_line ?? "");
  if (!line) return null;

  const key: SailingKey = {
    line,
    ship: s.ship_name,
    sailDate: s.departure_date,
    departurePort: s.departure_port,
    durationNights: s.duration_nights,
  };

  const cacheQuote = s.starting_price_usd != null && s.starting_price_usd > 0
    ? {
        key,
        cabinPrices: { interior: { amount: s.starting_price_usd, currency: "USD" as const } },
        fetchedAt: new Date(),
        source: "diy_cruisemapper" as const,
      }
    : null;

  return {
    key,
    cacheQuote,
    text: s.text,
    region: s.region,
    portsOfCall: s.ports_of_call,
    startingPriceUsd: s.starting_price_usd,
    sourceUrl: s.source_url,
    dayByDay: s.itinerary,
  };
}

/**
 * Map one upcoming-sailing list item (from parseSailingList) to MappedItinerary.
 * List items have no per-day detail, so dayByDay is null. Useful for pricing
 * cache updates and RAG text ingest for future sailings.
 */
export function mapSailingListItem(
  item: SailingListItem,
  shipName: string,
  cruiseLine: string,
): MappedItinerary | null {
  const line = normalizeLineCode(cruiseLine);
  if (!line) return null;

  const key: SailingKey = {
    line,
    ship: shipName,
    sailDate: item.departure_date,
    departurePort: item.departure_port,
    durationNights: item.duration_nights,
  };

  const text = renderText(
    line, cruiseLine, shipName,
    item.departure_date, item.departure_port,
    item.duration_nights, [], item.region, item.starting_price_usd,
  );

  const cacheQuote = item.starting_price_usd != null && item.starting_price_usd > 0
    ? {
        key,
        cabinPrices: { interior: { amount: item.starting_price_usd, currency: "USD" as const } },
        fetchedAt: new Date(),
        source: "diy_cruisemapper" as const,
      }
    : null;

  return {
    key,
    cacheQuote,
    text,
    region: item.region,
    portsOfCall: [],
    startingPriceUsd: item.starting_price_usd,
    sourceUrl: null,
    dayByDay: null,
  };
}

/** Deterministic chunk-source identifier per §BP35 task 5. */
export function chunkSourceIdentifier(key: SailingKey): string {
  return `cruisemapper:itinerary:${key.line}:${key.ship}:${key.sailDate}:${key.durationNights}`;
}
