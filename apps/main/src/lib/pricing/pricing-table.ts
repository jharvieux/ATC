// EPIC #1336, Phase 1 — DB-backed pricing loader.
//
// tier_definitions.base_price_*_cents + the pricing_seat_ladder table are the
// single source of truth for subscription pricing (display + §27 abuse-revenue
// math). This loads them into the PricingTable shape the lib/abuse/revenue.ts
// compute functions consume, with a short in-process cache (mirrors the
// lib/abuse/snapshot.ts pattern — invalidation is by TTL).
//
// Both tables are RLS-enabled-zero-policy + PLATFORM_READABLE, so reads go
// through the service-role client (the caller passes one in). On a read failure
// or an unseeded DB we fall back to PRICING_FALLBACK (the §3.3 seed values) so
// pricing never hard-fails — it just reverts to the code defaults until the read
// recovers. The fallback is NOT cached, so the next call retries the DB.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PricingTable, SeatBand, TenantTierCode } from "@/lib/abuse/revenue";
import { safeAwait } from "@/lib/db/safe-mutation";

// §3.3 seed values — seeded the DB via migration 20260707000000. This is the
// defense-in-depth fallback used by loadPricingTable when the DB is
// unreachable or unseeded (fresh local env). NOT a runtime default for callers:
// runtime call sites receive a loaded PricingTable from loadPricingTable().
export const PRICING_FALLBACK: PricingTable = {
  base: {
    byo_research:     { monthly:  1900, annual:  19000 },
    byo_professional: { monthly:  5900, annual:  59000 },
    byo_agency:       { monthly:  9900, annual:  99000 },
    sub_starter:      { monthly:  4900, annual:  49000 },
    sub_pro:          { monthly: 14900, annual: 149000 },
    sub_agency:       { monthly: 24900, annual: 249000 },
  },
  seatLadder: [
    { upTo:        4, monthly: 5900, annual: 59000 }, // users 2–4
    { upTo:       10, monthly: 4900, annual: 49000 }, // users 5–10
    { upTo: Infinity, monthly: 3900, annual: 39000 }, // users 11+
  ],
};

const TTL_MS = 60_000;
let cache: { table: PricingTable; fetched_at: number } | null = null;

const VALID_TIER_CODES: readonly string[] = [
  "byo_research", "byo_professional", "byo_agency",
  "sub_starter", "sub_pro", "sub_agency",
];

export async function loadPricingTable(db: SupabaseClient): Promise<PricingTable> {
  if (cache && Date.now() - cache.fetched_at < TTL_MS) return cache.table;

  try {
    const [tiersRes, ladderRes] = await Promise.all([
      safeAwait(
        db.from("tier_definitions").select("code, base_price_monthly_cents, base_price_annual_cents"),
        "tier_definitions.load-pricing",
      ),
      safeAwait(
        db
          .from("pricing_seat_ladder")
          .select("up_to_seat, monthly_cents, annual_cents")
          .order("sort_order", { ascending: true }),
        "pricing_seat_ladder.load",
      ),
    ]);

    const tierRows = (tiersRes ?? []) as Array<{
      code: string;
      base_price_monthly_cents: number;
      base_price_annual_cents: number;
    }>;
    const ladderRows = (ladderRes ?? []) as Array<{
      up_to_seat: number;
      monthly_cents: number;
      annual_cents: number;
    }>;

    // Start from the fallback so a partially-seeded DB still yields every tier.
    const base: PricingTable["base"] = { ...PRICING_FALLBACK.base };
    for (const r of tierRows) {
      if (VALID_TIER_CODES.includes(r.code)) {
        base[r.code as TenantTierCode] = {
          monthly: r.base_price_monthly_cents,
          annual: r.base_price_annual_cents,
        };
      }
    }

    const seatLadder: SeatBand[] =
      ladderRows.length > 0
        ? ladderRows.map((r) => ({ upTo: r.up_to_seat, monthly: r.monthly_cents, annual: r.annual_cents }))
        : PRICING_FALLBACK.seatLadder;

    const table: PricingTable = { base, seatLadder };
    cache = { table, fetched_at: Date.now() };
    return table;
  } catch {
    // Transient read failure: serve the fallback without caching it, so the
    // next call retries the DB rather than pinning the fallback for the TTL.
    return PRICING_FALLBACK;
  }
}

/**
 * Monthly-equivalent price in cents for a tier's base price under a billing
 * period. Annual plans return annual / 12 (rounded) so a "$X/mo" display is
 * honest; any non-"annual" period is treated as monthly. Shared by the
 * dashboard plan card (and Phase 3 billing/admin surfaces) so the period-aware
 * rule lives in one tested place.
 */
export function tierMonthlyPriceCents(
  base: { monthly: number; annual: number },
  billingPeriod: string | null,
): number {
  return billingPeriod === "annual" ? Math.round(base.annual / 12) : base.monthly;
}

/** Test-only: clear the in-process cache between specs. */
export function _resetPricingCacheForTests(): void {
  cache = null;
}
