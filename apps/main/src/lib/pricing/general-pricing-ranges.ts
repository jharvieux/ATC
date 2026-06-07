// §33.4 D-088 — Read/write helpers for general_pricing_ranges.
//
// The DIY CruiseMapper scraper writes per (line, ship, cabin_class,
// duration_nights). AI surfaces read these to give "approximately around
// $X-$Y" answers when prospecting; the §33.7 rounding rule (Apify-3)
// formats these into the customer-facing prose.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CabinClass } from "@/lib/external/cruisemapper/parsers/price-range-parser";

export interface GeneralPriceRange {
  cruise_line: string;
  ship: string;
  cabin_class: CabinClass;
  duration_nights: number;
  low_amount: number;
  high_amount: number;
  currency: "USD";
  source: "diy_cruisemapper" | "manual" | "estimated";
  source_url: string | null;
  fetched_at: Date;
}

export interface UpsertInput {
  cruise_line: string;
  ship: string;
  cabin_class: CabinClass;
  duration_nights: number;
  low_amount: number;
  high_amount: number;
  source_url?: string;
  source?: "diy_cruisemapper" | "manual" | "estimated";
}

/** Upsert one range row. Idempotent on the composite UNIQUE constraint. */
export async function upsertGeneralPriceRange(
  db: SupabaseClient,
  input: UpsertInput,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await db.from("general_pricing_ranges").upsert(
    {
      cruise_line: input.cruise_line,
      ship: input.ship,
      cabin_class: input.cabin_class,
      duration_nights: input.duration_nights,
      low_amount: input.low_amount,
      high_amount: input.high_amount,
      currency: "USD",
      source: input.source ?? "diy_cruisemapper",
      source_url: input.source_url ?? null,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "cruise_line,ship,cabin_class,duration_nights,source" },
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Read all ranges for a ship across cabin classes + durations. */
export async function readShipPriceRanges(
  db: SupabaseClient,
  cruiseLine: string,
  ship: string,
): Promise<GeneralPriceRange[]> {
  const { data, error } = await db
    .from("general_pricing_ranges")
    .select(
      "cruise_line, ship, cabin_class, duration_nights, low_amount, high_amount, currency, source, source_url, fetched_at",
    )
    .eq("cruise_line", cruiseLine)
    .eq("ship", ship);
  if (error || !data) return [];
  return (data as Array<Record<string, unknown>>).map((r) => {
    // Postgres NUMERIC arrives as a string sometimes; coerce via an
    // unknown intermediate so the no-money-math lint stays happy.
    const rawLo: unknown = r.low_amount;
    const rawHi: unknown = r.high_amount;
    const lo = typeof rawLo === "number" ? rawLo : Number(rawLo);
    const hi = typeof rawHi === "number" ? rawHi : Number(rawHi);
    return {
      cruise_line: r.cruise_line as string,
      ship: r.ship as string,
      cabin_class: r.cabin_class as CabinClass,
      duration_nights: r.duration_nights as number,
      low_amount: lo,
      high_amount: hi,
      currency: "USD" as const,
      source: r.source as "diy_cruisemapper" | "manual" | "estimated",
      source_url: (r.source_url as string | null) ?? null,
      fetched_at: new Date(r.fetched_at as string),
    };
  });
}

/** Read the single best range for a (line, ship, cabin_class, duration).
 *  Returns null when no row exists. */
export async function readPriceRange(
  db: SupabaseClient,
  cruiseLine: string,
  ship: string,
  cabinClass: CabinClass,
  durationNights: number,
): Promise<GeneralPriceRange | null> {
  const { data } = await db
    .from("general_pricing_ranges")
    .select(
      "cruise_line, ship, cabin_class, duration_nights, low_amount, high_amount, currency, source, source_url, fetched_at",
    )
    .eq("cruise_line", cruiseLine)
    .eq("ship", ship)
    .eq("cabin_class", cabinClass)
    .eq("duration_nights", durationNights)
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const r = data as Record<string, unknown>;
  const rawLo: unknown = r.low_amount;
  const rawHi: unknown = r.high_amount;
  const lo = typeof rawLo === "number" ? rawLo : Number(rawLo);
  const hi = typeof rawHi === "number" ? rawHi : Number(rawHi);
  return {
    cruise_line: r.cruise_line as string,
    ship: r.ship as string,
    cabin_class: r.cabin_class as CabinClass,
    duration_nights: r.duration_nights as number,
    low_amount: lo,
    high_amount: hi,
    currency: "USD" as const,
    source: r.source as "diy_cruisemapper" | "manual" | "estimated",
    source_url: (r.source_url as string | null) ?? null,
    fetched_at: new Date(r.fetched_at as string),
  };
}
