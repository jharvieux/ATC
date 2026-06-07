// #828b / #820 — derive ballpark per-cabin price ranges from interior lead-ins.
//
// CruiseMapper removed its per-cabin price widgets (#820), so the only free
// price is the per-sailing interior "from $X" lead-in (written to pricing_cache
// with cabin_class='interior' by the sailing ingest). For each
// (cruise_line, ship, duration_nights) we take the min/max of observed interior
// lead-ins as the interior range, then scale by category multipliers to ESTIMATE
// the other cabin tiers. Stored with source='estimated' so the provenance is
// honest (NOT scraped per-cabin). The chat path surfaces these via
// build-pricing-anchors-block, which already frames every anchor as approximate
// and applies the §33.7 +10%/nearest-$100 buffer at display time.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ALL_CABIN_CLASSES, type CabinClass } from "./types";

// Interior is the base (the lead-in itself, multiplier 1.0). The other tiers are
// rough industry multiples over the interior lead-in — ESTIMATES, not scraped.
// Per #828 (oceanview ≈1.3, balcony ≈1.6, suite ≈3); mini_suite interpolated
// between balcony and suite. Tune here if real per-cabin data ever returns.
export const CABIN_MULTIPLIERS: Record<CabinClass, number> = {
  interior: 1.0,
  oceanview: 1.3,
  balcony: 1.6,
  mini_suite: 2.2,
  suite: 3.0,
};

export interface InteriorLeadIn {
  cruise_line: string;
  ship: string;
  duration_nights: number;
  price_amount: number;
}

export interface DerivedRangeRow {
  cruise_line: string;
  ship: string;
  cabin_class: CabinClass;
  duration_nights: number;
  low_amount: number;
  high_amount: number;
}

// Collision-free group key (line/ship can contain any punctuation, so a string
// separator is unsafe — JSON.stringify escapes properly).
function groupKey(cruiseLine: string, ship: string, durationNights: number): string {
  return JSON.stringify([cruiseLine, ship, durationNights]);
}

// Pure: aggregate interior lead-ins by (line, ship, duration) into an interior
// min/max range, then scale each cabin tier by its multiplier. Rows with a
// non-positive price/duration or missing line/ship are skipped — a bad lead-in
// must not poison a group's range.
export function deriveRangesFromLeadIns(rows: InteriorLeadIn[]): DerivedRangeRow[] {
  const groups = new Map<string, { cruise_line: string; ship: string; duration_nights: number; lo: number; hi: number }>();
  for (const r of rows) {
    if (!(r.price_amount > 0) || !(r.duration_nights > 0) || !r.cruise_line || !r.ship) continue;
    const key = groupKey(r.cruise_line, r.ship, r.duration_nights);
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { cruise_line: r.cruise_line, ship: r.ship, duration_nights: r.duration_nights, lo: r.price_amount, hi: r.price_amount });
    } else {
      if (r.price_amount < g.lo) g.lo = r.price_amount;
      if (r.price_amount > g.hi) g.hi = r.price_amount;
    }
  }

  const out: DerivedRangeRow[] = [];
  for (const g of groups.values()) {
    for (const cabin of ALL_CABIN_CLASSES) {
      const mult = CABIN_MULTIPLIERS[cabin];
      out.push({
        cruise_line: g.cruise_line,
        ship: g.ship,
        cabin_class: cabin,
        duration_nights: g.duration_nights,
        low_amount: Math.round(g.lo * mult),
        high_amount: Math.round(g.hi * mult),
      });
    }
  }
  return out;
}

const PAGE = 1000; // PostgREST default cap (#808)
const UPSERT_BATCH = 500;

export interface DeriveResult {
  lead_ins_read: number;
  groups: number;
  rows_upserted: number;
}

// Read every interior lead-in from pricing_cache (paginated past the 1000-row
// PostgREST cap), derive ranges, and upsert them with source='estimated'.
// Idempotent on the (line, ship, cabin_class, duration, source) unique key.
export async function runDeriveGeneralPriceRanges(db: SupabaseClient): Promise<DeriveResult> {
  const leadIns: InteriorLeadIn[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("pricing_cache")
      .select("cruise_line, ship, duration_nights, price_amount")
      .eq("cabin_class", "interior")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`pricing_cache.select(interior) failed: ${error.message}`);
    const batch = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of batch) {
      const rawAmt: unknown = r.price_amount;
      leadIns.push({
        cruise_line: r.cruise_line as string,
        ship: r.ship as string,
        duration_nights: Number(r.duration_nights),
        price_amount: typeof rawAmt === "number" ? rawAmt : Number(rawAmt),
      });
    }
    if (batch.length < PAGE) break;
  }

  const rows = deriveRangesFromLeadIns(leadIns);
  const fetchedAt = new Date().toISOString();
  let upserted = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const chunk = rows.slice(i, i + UPSERT_BATCH).map((r) => ({
      cruise_line: r.cruise_line,
      ship: r.ship,
      cabin_class: r.cabin_class,
      duration_nights: r.duration_nights,
      low_amount: r.low_amount,
      high_amount: r.high_amount,
      currency: "USD" as const,
      source: "estimated" as const,
      source_url: null,
      fetched_at: fetchedAt,
    }));
    const { error } = await db
      .from("general_pricing_ranges")
      .upsert(chunk, { onConflict: "cruise_line,ship,cabin_class,duration_nights,source" });
    if (error) throw new Error(`general_pricing_ranges.upsert failed: ${error.message}`);
    upserted += chunk.length;
  }

  const distinctGroups = new Set(rows.map((r) => groupKey(r.cruise_line, r.ship, r.duration_nights))).size;
  return { lead_ins_read: leadIns.length, groups: distinctGroups, rows_upserted: upserted };
}
