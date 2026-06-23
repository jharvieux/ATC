// §14.x / §15.8 — Stripe Price ID centralization.
//
// Maps tenant type + tier + billing period to the correct Stripe Price ID.
// The DB table stripe_price_map is the source of truth (EPIC #1336 Phase 2):
// callers load it once per request with loadPriceMap(serviceRoleClient) and
// pass the result to priceIdFor(). The STRIPE_PRICE_* env vars remain the
// fallback for any key the DB hasn't been seeded with, so behavior is unchanged
// until rows exist. All references go through priceIdFor().

import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { SEAT_LADDER, type SeatBand } from "@/lib/abuse/revenue";
import { safeAwait } from "@/lib/db/safe-mutation";
import { PRICE_ID_ENV_MAP } from "@/lib/stripe/price-id-map";

export type TenantType = "sub_host" | "byo_host";
export type Tier = "starter" | "pro" | "agency";
export type BillingPeriod = "monthly" | "annual";
export type LineItem = "base" | "additional_seats";

export interface PriceIdQuery {
  tenant_type: TenantType;
  tier: Tier;
  billing_period: BillingPeriod;
  line_item: LineItem;
}

function keyFor(query: PriceIdQuery): string {
  return `${query.tenant_type}.${query.tier}.${query.billing_period}.${query.line_item}`;
}

/** DB-loaded Price IDs keyed by `${tenant_type}.${tier}.${period}.${line_item}`. */
export type PriceMap = Map<string, { priceId: string; amountCents: number | null }>;

interface StripePriceMapRow {
  tenant_type: string;
  tier: string;
  billing_period: string;
  line_item: string;
  stripe_price_id: string;
  amount_cents: number | null;
}

const TTL_MS = 60_000;
let cache: { map: PriceMap; fetched_at: number } | null = null;

// Load the Stripe Price-ID map from stripe_price_map (service-role read), with a
// short in-process cache (mirrors lib/pricing/pricing-table.ts). On read failure
// — or an unseeded table — we return an empty map WITHOUT caching it, so the
// next call retries the DB and priceIdFor() falls back to the env vars in the
// meantime. Pass the result to priceIdFor().
export async function loadPriceMap(db: SupabaseClient): Promise<PriceMap> {
  if (cache && Date.now() - cache.fetched_at < TTL_MS) return cache.map;

  try {
    const rows = await safeAwait<StripePriceMapRow[]>(
      db
        .from("stripe_price_map")
        .select("tenant_type, tier, billing_period, line_item, stripe_price_id, amount_cents"),
      "stripe_price_map.select",
    );

    const map: PriceMap = new Map();
    for (const r of rows ?? []) {
      map.set(`${r.tenant_type}.${r.tier}.${r.billing_period}.${r.line_item}`, {
        priceId: r.stripe_price_id,
        amountCents: r.amount_cents,
      });
    }

    // Only cache a non-empty result: an empty table means "not seeded yet", and
    // we don't want to pin the env-fallback path for a full TTL once seeding runs.
    if (map.size > 0) cache = { map, fetched_at: Date.now() };
    return map;
  } catch {
    return new Map();
  }
}

// Resolve the Stripe Price ID for a query. The DB-loaded `map` wins; when a key
// is absent (table unseeded, or this specific line item missing) we fall back to
// the STRIPE_PRICE_* env var. Throws only when neither source has it.
export function priceIdFor(query: PriceIdQuery, map: PriceMap = new Map()): string {
  const key = keyFor(query);

  const fromDb = map.get(key);
  if (fromDb?.priceId) return fromDb.priceId;

  const envKey = PRICE_ID_ENV_MAP[key];
  if (!envKey) {
    throw new Error(`No Stripe Price ID mapping for: ${key}`);
  }
  const e = env();
  const priceId = (e as unknown as Record<string, string | undefined>)[envKey];
  if (!priceId) {
    throw new Error(`Stripe Price ID for '${key}' not found in stripe_price_map and env var '${envKey}' is not set.`);
  }
  return priceId;
}

/** Test-only: clear the in-process price-map cache between specs. */
export function _resetPriceMapCacheForTests(): void {
  cache = null;
}

// The ladder is indexed by total seat number; this function receives the count
// of ADDITIONAL seats (caller passes seatCount - 1, since seat 1 is covered by
// the base price). The ladder defaults to the SEAT_LADDER fallback; runtime
// callers inject the DB-loaded ladder. Uses a Math.min walk (matching
// ladderTotalCents) so the open-ended final band works whether its `upTo` is
// Infinity (fallback) or the INT4-max sentinel (DB) — never an `=== Infinity`
// check, which would silently mis-price the top band for DB-loaded ladders.
export function calculateAgencySeatPreviewCents(
  additionalSeats: number,
  billingPeriod: BillingPeriod,
  ladder: SeatBand[] = SEAT_LADDER,
): number {
  if (additionalSeats <= 0) return 0;
  const totalSeats = additionalSeats + 1; // seat 1 is the base seat
  let total = 0;
  let lastSeatProcessed = 1;
  for (const band of ladder) {
    if (totalSeats <= lastSeatProcessed) break;
    const upperBand = Math.min(totalSeats, band.upTo);
    const seatsInBand = upperBand - lastSeatProcessed;
    if (seatsInBand > 0) {
      total += seatsInBand * (billingPeriod === "annual" ? band.annual : band.monthly);
    }
    lastSeatProcessed = upperBand;
  }
  return total;
}
