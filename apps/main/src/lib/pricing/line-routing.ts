// BP34 §33.3 / D-088 Apify-4 — per-line routing table for ApifyPricingAdapter.
//
// All 9 supported cruise lines route to a `sercul/` actor whose slug was
// confirmed via Apify Store on 2026-05-26. Each line has an env-based kill
// switch (`APIFY_ENABLED_<LINE>`) so operator can disable any one line
// without touching code or the global APIFY_ADAPTER_ENABLED.
//
// 6-line survey result (2026-05-26): no dedicated Apify actors exist for
// Virgin Voyages, Viking, Oceania, Regent Seven Seas, Silversea, Seabourn.
// Those lines stay out of LINE_ROUTES — `routeFor` returns null, and
// `getCachedPrice` returns `{ status: 'unsupported' }`. General pricing for
// those lines comes from the DIY CruiseMapper scraper (Apify-2).
//
// Aggregator fallback (`vulnv/booking-cruises-scraper`) intentionally NOT
// auto-routed — operator opts in per-line by adding a dedicated route.
//
// Actor input shape (D-088 Apify-4): every `sercul/*` actor accepts
// `{ region, maxRows, useApifyProxy, ... }` and dumps the whole market.
// One actor run per line refreshes every watched US sailing for that line
// in a single $1-$2 charge. Watched-sailing filtering happens client-side
// in the adapter (see `matchesAnyWatchedSailing`).

import type { CachedPriceQuote, CabinClass, CruiseLineCode, SailingKey } from "./types";
import { ALL_CABIN_CLASSES } from "./types";

const DEFAULT_MAX_ROWS_PER_RUN = 2000;

export interface ActorInput {
  /** Apify expects per-actor input JSON; we pass the raw shape through. */
  [key: string]: unknown;
}

export interface LineRoute {
  cruiseLine: CruiseLineCode;
  actorId: string;
  /** Market code the actor expects for US results — sercul codes vary
   *  ("USA" for RCL/NCL/PCL/CEL/COS, "US" for CCL/HAL/MSC/DSY). */
  marketCode: string;
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

// ──────────────────────────────────────────────────────────────────────────
// Input builder — D-088 Apify-4 actor-shape-correct.
//
// All sercul actors accept the same envelope: `{ region, maxRows, ... }`.
// Sailings are NOT a filter input — the actor returns the whole market.
// The adapter filters returned items against the watched-sailing set
// client-side (see `matchesAnyWatchedSailing`).
// ──────────────────────────────────────────────────────────────────────────

function maxRowsPerRun(): number {
  const raw = process.env.APIFY_MAX_ROWS_PER_RUN;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_ROWS_PER_RUN;
}

function buildSerculInputFor(marketCode: string) {
  return (sailings: SailingKey[]): ActorInput => {
    // Input is market-level. `sailings` is intentionally unused — its
    // role moved to client-side filtering on the response items.
    void sailings;
    return {
      region: marketCode,
      maxRows: maxRowsPerRun(),
      useApifyProxy: true,
    };
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Per-line kill switch — `APIFY_ENABLED_<LINE>=false` disables a single
// line. Default ENABLED for any line in LINE_ROUTES. Operator flips during
// incident triage when one actor starts erroring or burning budget.
// ──────────────────────────────────────────────────────────────────────────

export function isLineEnabledByEnv(line: CruiseLineCode): boolean {
  return process.env[`APIFY_ENABLED_${line}`] !== "false";
}

// ──────────────────────────────────────────────────────────────────────────
// Route table — D-088 Apify-4 (2026-05-26 catalog research):
//   9 lines with confirmed `sercul/` actor slugs + US market codes.
//   6 lines surveyed and confirmed unavailable (see file header).
// ──────────────────────────────────────────────────────────────────────────

export const LINE_ROUTES: Readonly<Record<CruiseLineCode, LineRoute | null>> = Object.freeze({
  RCL: { cruiseLine: "RCL", actorId: "sercul/royal-caribbean",          marketCode: "USA", inputBuilder: buildSerculInputFor("USA"), outputMapper: (i) => mapSerculItem(i, "RCL") },
  NCL: { cruiseLine: "NCL", actorId: "sercul/norwegian-cruise-scraper", marketCode: "USA", inputBuilder: buildSerculInputFor("USA"), outputMapper: (i) => mapSerculItem(i, "NCL") },
  PCL: { cruiseLine: "PCL", actorId: "sercul/princess-cruise-scraper",  marketCode: "USA", inputBuilder: buildSerculInputFor("USA"), outputMapper: (i) => mapSerculItem(i, "PCL") },
  CEL: { cruiseLine: "CEL", actorId: "sercul/celebrity-cruises",        marketCode: "USA", inputBuilder: buildSerculInputFor("USA"), outputMapper: (i) => mapSerculItem(i, "CEL") },
  COS: { cruiseLine: "COS", actorId: "sercul/costa-cruises",            marketCode: "USA", inputBuilder: buildSerculInputFor("USA"), outputMapper: (i) => mapSerculItem(i, "COS") },
  CCL: { cruiseLine: "CCL", actorId: "sercul/carnival-cruises",         marketCode: "US",  inputBuilder: buildSerculInputFor("US"),  outputMapper: (i) => mapSerculItem(i, "CCL") },
  HAL: { cruiseLine: "HAL", actorId: "sercul/hal-cruises-scraper",      marketCode: "US",  inputBuilder: buildSerculInputFor("US"),  outputMapper: (i) => mapSerculItem(i, "HAL") },
  MSC: { cruiseLine: "MSC", actorId: "sercul/msc-cruises-scraper",      marketCode: "US",  inputBuilder: buildSerculInputFor("US"),  outputMapper: (i) => mapSerculItem(i, "MSC") },
  DSY: { cruiseLine: "DSY", actorId: "sercul/disney-cruises-scraper",   marketCode: "US",  inputBuilder: buildSerculInputFor("US"),  outputMapper: (i) => mapSerculItem(i, "DSY") },
  // Aggregator fallback — NOT auto-routed. Operator opts in by writing a
  // dedicated LineRoute when ready.
  BCK: null,
});

/** Return the route for a line, or null if (a) no actor covers it OR
 *  (b) operator has disabled the line via `APIFY_ENABLED_<LINE>=false`. */
export function routeFor(line: CruiseLineCode): LineRoute | null {
  const r = LINE_ROUTES[line];
  if (!r) return null;
  if (!isLineEnabledByEnv(line)) return null;
  return r;
}

// ──────────────────────────────────────────────────────────────────────────
// Client-side filter — D-088 Apify-4.
//
// Apify actors dump the whole market; this matcher keeps only items that
// correspond to a sailing in the watched set. Match by structural key
// (ship, sailDate, departurePort, durationNights) — the `line` is implicit
// because each actor is line-specific.
// ──────────────────────────────────────────────────────────────────────────

function sailingMatches(a: SailingKey, b: SailingKey): boolean {
  return (
    a.ship === b.ship &&
    a.sailDate === b.sailDate &&
    a.departurePort === b.departurePort &&
    a.durationNights === b.durationNights
  );
}

export function matchesAnyWatchedSailing(
  quote: { key: SailingKey },
  watched: SailingKey[],
): boolean {
  return watched.some((w) => sailingMatches(w, quote.key));
}

// ──────────────────────────────────────────────────────────────────────────
// Batching — D-088 Apify-4.
//
// Group by `line` only. One actor run per line per refresh covers every
// watched US sailing for that line. (Old (line, port, month) bucketing
// over-charged us 6-12x by firing per port-month rather than per line.)
// ──────────────────────────────────────────────────────────────────────────

export function groupSailingsForBatch(
  sailings: SailingKey[],
): Array<{ line: CruiseLineCode; sailings: SailingKey[] }> {
  const buckets = new Map<CruiseLineCode, SailingKey[]>();
  for (const s of sailings) {
    const existing = buckets.get(s.line);
    if (existing) existing.push(s);
    else buckets.set(s.line, [s]);
  }
  return [...buckets.entries()].map(([line, group]) => ({ line, sailings: group }));
}
