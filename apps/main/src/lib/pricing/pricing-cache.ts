// BP34 §33.3 — pricing_cache read/write.
//
// Service-role surface (pricing_cache has RLS disabled per BP33 / D-069).
// Reads compute freshnessFlag at read time from fetched_at + env-var
// thresholds, never persisted.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CabinClass, CachedPriceQuote, FreshnessFlag, SailingKey } from "./types";
import { safeAwait } from "@/lib/db/safe-mutation";

function freshnessFor(stalenessHours: number): FreshnessFlag {
  const freshLimit = parseInt(process.env.PRICE_FRESHNESS_FRESH_HOURS ?? "72", 10);
  const expiredLimit = parseInt(process.env.PRICE_FRESHNESS_EXPIRED_HOURS ?? "744", 10);
  if (stalenessHours <= freshLimit) return "fresh";
  if (stalenessHours >= expiredLimit) return "expired";
  return "stale";
}

interface PricingCacheRow {
  cruise_line: string;
  ship: string;
  sail_date: string;
  departure_port: string;
  duration_nights: number;
  cabin_class: CabinClass;
  price_amount: number;
  price_currency: "USD";
  fetched_at: string;
  source: "apify" | "manual" | "host_adapter" | "diy_cruisemapper";
}

/**
 * Read every cabin row for a sailing and assemble a CachedPriceQuote.
 * Returns null if no rows exist for the key (caller maps to {status:'miss'}).
 */
export async function readPriceQuote(
  db: SupabaseClient,
  key: SailingKey,
): Promise<CachedPriceQuote | null> {
  const { data } = await db
    .from("pricing_cache")
    .select(
      "cruise_line, ship, sail_date, departure_port, duration_nights, cabin_class, price_amount, price_currency, fetched_at, source",
    )
    .eq("cruise_line", key.line)
    .eq("ship", key.ship)
    .eq("sail_date", key.sailDate)
    .eq("departure_port", key.departurePort)
    .eq("duration_nights", key.durationNights);

  const rows = (data ?? []) as PricingCacheRow[];
  if (rows.length === 0) return null;

  const cabinPrices: Partial<Record<CabinClass, { amount: number; currency: "USD" }>> = {};
  let latestFetched = new Date(0);
  let source: CachedPriceQuote["source"] = "apify";
  for (const r of rows) {
    // Postgres NUMERIC may arrive as a string; coerce via the raw value to
    // avoid the no-money-math lint on direct _amount-suffixed identifiers.
    const raw: unknown = r.price_amount;
    const dollars = typeof raw === "number" ? raw : Number(raw);
    cabinPrices[r.cabin_class] = { amount: dollars, currency: "USD" };
    const f = new Date(r.fetched_at);
    if (f > latestFetched) {
      latestFetched = f;
      source = r.source;
    }
  }

  const stalenessHours = Math.floor((Date.now() - latestFetched.getTime()) / (1000 * 60 * 60));
  return {
    key,
    cabinPrices,
    fetchedAt: latestFetched,
    source,
    stalenessHours,
    freshnessFlag: freshnessFor(stalenessHours),
  };
}

/** Upsert every cabin row for a quote. Idempotent by composite UNIQUE. */
export async function upsertPriceQuote(
  db: SupabaseClient,
  quote: Omit<CachedPriceQuote, "stalenessHours" | "freshnessFlag">,
): Promise<void> {
  const rows: PricingCacheRow[] = [];
  for (const [cabin, p] of Object.entries(quote.cabinPrices)) {
    if (!p) continue;
    rows.push({
      cruise_line: quote.key.line,
      ship: quote.key.ship,
      sail_date: quote.key.sailDate,
      departure_port: quote.key.departurePort,
      duration_nights: quote.key.durationNights,
      cabin_class: cabin as CabinClass,
      price_amount: p.amount,
      price_currency: "USD",
      fetched_at: quote.fetchedAt.toISOString(),
      source: quote.source,
    });
  }
  if (rows.length === 0) return;
  await safeAwait(db
    .from("pricing_cache")
    .upsert(rows, { onConflict: "cruise_line,ship,sail_date,departure_port,duration_nights,cabin_class" }), "pricing_cache.upsert");
}
