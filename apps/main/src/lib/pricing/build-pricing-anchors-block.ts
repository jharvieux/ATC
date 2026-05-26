// §33.7 D-088 — Build the PRICING ANCHORS system-prompt block.
//
// Reads general_pricing_ranges for the (cruise_line, ship) pairs the
// conversation has touched, formats each row with the §33.7 rounding
// rule, and emits a deterministic block to inject after the knowledge
// block but before the tone calibration in build-system-prompt.ts.
//
// Empty input → empty string (caller skips the section entirely).

import type { SupabaseClient } from "@supabase/supabase-js";
import { formatPriceAnchorRange } from "./format-price-anchor";

export interface PricingAnchorContext {
  /** Cruise line names from §21.2 entity extraction (or memory). */
  cruiseLines: string[];
  /** Ship names from entity extraction or memory. */
  ships: string[];
}

interface AnchorRow {
  cruise_line: string;
  ship: string;
  cabin_class: string;
  duration_nights: number;
  low_amount: number;
  high_amount: number;
  source_url: string | null;
  fetched_at: string;
}

const MAX_ANCHORS_PER_PROMPT = 24; // 4 cabin classes × ~2 durations × ~3 ships

const STATIC_PRICING_GUIDANCE = `
PRICING GUIDANCE (mandatory — applies to every customer-facing reply):

You may have access to PRICING ANCHORS below. These are ballpark cabin
price ranges sourced from public reference data, NOT confirmed quotes.
When you reference a price in prose:

1. Always frame the number as approximate. Use one of:
   "approximately", "around", "roughly", "about", "starting around".
2. The PRICING ANCHORS below are ALREADY rounded per the platform rule
   (+10% buffer, nearest $100). Surface them VERBATIM. Do not re-round
   or back out the buffer in your reply.
3. If a range is available, surface BOTH ends:
   "around $1,300 to $3,900"
4. Never present an anchored price as final or quote-able. The exact
   number depends on sail date, cabin location, occupancy, and live
   availability. Always add a soft caveat:
   "exact price varies by sail date and cabin location" or
   "live pricing from the host system will be more accurate."
5. This rounding rule does NOT apply when you're echoing back a price
   the customer just stated, or when reading from a confirmed-quote
   price (§21.10.1) that you can cite by quote_id.
6. If no PRICING ANCHORS appear below, do NOT invent ballpark prices.
   Tell the customer "I don't have a current price anchor for that
   sailing on hand — let me check with the booking system for live
   availability."
`.trim();

/** Build the PRICING ANCHORS block. Returns the empty string when there
 *  are no anchors for the conversation's entities. */
export async function buildPricingAnchorsBlock(
  db: SupabaseClient,
  ctx: PricingAnchorContext,
): Promise<string> {
  if (process.env.AI_PRICE_ROUNDING_ENABLED === "false") {
    // Operator killed the rule — emit nothing.
    return "";
  }
  if (ctx.cruiseLines.length === 0 && ctx.ships.length === 0) {
    return "";
  }

  // Query: pull rows where either the cruise_line or the ship matches
  // anything in the entity set. Case-insensitive via ilike. Bound by
  // MAX_ANCHORS_PER_PROMPT so the prompt doesn't balloon.
  let q = db
    .from("general_pricing_ranges")
    .select(
      "cruise_line, ship, cabin_class, duration_nights, low_amount, high_amount, source_url, fetched_at",
    )
    .limit(MAX_ANCHORS_PER_PROMPT);

  const orClauses: string[] = [];
  for (const line of ctx.cruiseLines.slice(0, 5)) {
    orClauses.push(`cruise_line.ilike.${escapeIlike(line)}`);
  }
  for (const ship of ctx.ships.slice(0, 5)) {
    orClauses.push(`ship.ilike.${escapeIlike(ship)}`);
  }
  if (orClauses.length > 0) {
    q = q.or(orClauses.join(","));
  }

  const { data, error } = await q;
  if (error || !data || data.length === 0) return "";

  const rows = data as AnchorRow[];
  // Sort deterministically so the block is cache-stable.
  rows.sort((a, b) => {
    if (a.cruise_line !== b.cruise_line) return a.cruise_line.localeCompare(b.cruise_line);
    if (a.ship !== b.ship) return a.ship.localeCompare(b.ship);
    if (a.duration_nights !== b.duration_nights) return a.duration_nights - b.duration_nights;
    return a.cabin_class.localeCompare(b.cabin_class);
  });

  const lines = rows.map((r) => {
    const rawLo: unknown = r.low_amount;
    const rawHi: unknown = r.high_amount;
    const lo = typeof rawLo === "number" ? rawLo : Number(rawLo);
    const hi = typeof rawHi === "number" ? rawHi : Number(rawHi);
    const formatted = formatPriceAnchorRange(lo, hi);
    return `- ${r.cruise_line} / ${r.ship} / ${r.duration_nights}-night / ${r.cabin_class}: ${formatted}`;
  });

  return [
    STATIC_PRICING_GUIDANCE,
    "",
    "PRICING ANCHORS (available for this turn):",
    ...lines,
  ].join("\n");
}

/** Build only the static guidance text (no anchors). Used when we want
 *  to inject the rounding rule even without anchors so the model
 *  doesn't fabricate. */
export function buildPricingGuidanceOnly(): string {
  if (process.env.AI_PRICE_ROUNDING_ENABLED === "false") return "";
  return STATIC_PRICING_GUIDANCE;
}

function escapeIlike(s: string): string {
  // Escape % and , (PostgREST .or() uses commas as separators).
  return `%${s.replace(/[%,]/g, " ")}%`;
}
