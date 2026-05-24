// BP35 §33.4 — CruiseMapper itinerary normalization.
//
// One actor item → up to two outputs:
//   1. A CachedPriceQuote-shaped record for pricing_cache (only when the
//      actor included a starting price for the interior cabin).
//   2. A structured text doc for RAG ingest: dense, factual prose at the
//      §B.5 ~500-token target. The RAG service hashes the text for
//      content-hash idempotency, so the prose shape must be deterministic.

import type { CachedPriceQuote, SailingKey } from "@/lib/pricing/types";

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

const ALLOWED_LINES = new Set([
  "RCL", "NCL", "PCL", "CEL", "COS", "CCL", "HAL", "MSC", "DSY", "BCK",
]);

/** Best-effort actor-line-name → SailingKey.line code. */
function normalizeLineCode(raw: string): SailingKey["line"] | null {
  const upper = raw.toUpperCase().trim();
  if (ALLOWED_LINES.has(upper)) return upper as SailingKey["line"];
  // Common long-form mappings.
  const map: Record<string, SailingKey["line"]> = {
    "ROYAL CARIBBEAN": "RCL",
    "NORWEGIAN": "NCL",
    "NORWEGIAN CRUISE LINE": "NCL",
    "PRINCESS": "PCL",
    "PRINCESS CRUISES": "PCL",
    "CELEBRITY": "CEL",
    "CELEBRITY CRUISES": "CEL",
    "COSTA": "COS",
    "COSTA CRUISES": "COS",
    "CARNIVAL": "CCL",
    "HOLLAND AMERICA": "HAL",
    "MSC": "MSC",
    "MSC CRUISES": "MSC",
    "DISNEY": "DSY",
    "DISNEY CRUISE LINE": "DSY",
  };
  return map[upper] ?? null;
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
  };
}

/** Deterministic chunk-source identifier per §BP35 task 5. */
export function chunkSourceIdentifier(key: SailingKey): string {
  return `cruisemapper:itinerary:${key.line}:${key.ship}:${key.sailDate}:${key.durationNights}`;
}
