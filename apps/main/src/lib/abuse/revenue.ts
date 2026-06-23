// §27.4.1 / §3.3 — Effective monthly revenue computation.
//
// The single source of truth for what a tenant pays the platform per
// month, regardless of billing_period. Annual billers divide their annual
// price by 12. Multi-seat Agency tenants walk the §3.3 seat ladder.
//
// BigInt cents throughout. The numbers below seeded the DB (migration
// 20260707000000) which is now the single source of truth (EPIC #1336,
// Phase 1). They remain here ONLY as the defense-in-depth fallback when the
// DB hasn't been seeded (fresh local env, a test that bypassed migrations) —
// exactly mirroring TIER_BASE_FALLBACK in thresholds.ts. Runtime call sites
// pass a PricingTable loaded from the DB via lib/pricing/pricing-table.ts;
// the compute functions below default to PRICING_FALLBACK so pure-function
// callers and tests still work without a DB.

export type TenantTierCode =
  | "byo_research"
  | "byo_professional"
  | "byo_agency"
  | "sub_starter"
  | "sub_pro"
  | "sub_agency";

export type BillingPeriod = "monthly" | "annual";

export interface TenantRevenueSnapshot {
  tier_code: TenantTierCode;
  seat_count: number;
  billing_period: BillingPeriod;
}

// Per-tier base + ladder. Values in cents (BigInt-safe input).
// Cents = dollars × 100.
export const TIER_BASE_PRICE_CENTS: Record<TenantTierCode, { monthly: number; annual: number }> = {
  byo_research:     { monthly:  1900, annual:  19000 },
  byo_professional: { monthly:  5900, annual:  59000 },
  byo_agency:       { monthly:  9900, annual:  99000 },
  sub_starter:      { monthly:  4900, annual:  49000 },
  sub_pro:          { monthly: 14900, annual: 149000 },
  sub_agency:       { monthly: 24900, annual: 249000 },
};

// One seat-ladder band: prices seats up to (and including) `upTo`. The final
// band is open-ended — `upTo: Infinity` in the fallback, the INT4-max sentinel
// (2147483647) when loaded from the DB. Both compare correctly via Math.min.
export interface SeatBand {
  upTo: number;
  monthly: number;
  annual: number;
}

// Seat ladder — applies to BYO Agency + Sub-Host Agency (per §3.3).
// First seat is included in base; this ladder prices seats 2+.
export const SEAT_LADDER: SeatBand[] = [
  { upTo:  4, monthly: 5900, annual: 59000 }, // users 2–4
  { upTo: 10, monthly: 4900, annual: 49000 }, // users 5–10
  { upTo: Infinity, monthly: 3900, annual: 39000 }, // users 11+
];

// The full pricing picture the compute functions need, loadable from the DB
// (lib/pricing/pricing-table.ts) or defaulted to PRICING_FALLBACK below.
export interface PricingTable {
  base: Record<TenantTierCode, { monthly: number; annual: number }>;
  seatLadder: SeatBand[];
}

// Defense-in-depth fallback — the §3.3 numbers that seeded the DB. Used when a
// caller doesn't inject a DB-loaded table (tests, pure-function call sites).
export const PRICING_FALLBACK: PricingTable = {
  base: TIER_BASE_PRICE_CENTS,
  seatLadder: SEAT_LADDER,
};

const AGENCY_TIERS = new Set<TenantTierCode>(["byo_agency", "sub_agency"]);

function ladderTotalCents(seatCount: number, period: BillingPeriod, ladder: SeatBand[]): bigint {
  if (seatCount <= 1) return 0n;
  let total = 0n;
  let lastSeatProcessed = 1;
  for (const band of ladder) {
    if (seatCount <= lastSeatProcessed) break;
    const upperBand = Math.min(seatCount, band.upTo);
    const seatsInBand = upperBand - lastSeatProcessed;
    if (seatsInBand > 0) {
      const per = period === "monthly" ? band.monthly : band.annual;
      total += BigInt(seatsInBand) * BigInt(per);
    }
    lastSeatProcessed = upperBand;
  }
  return total;
}

/**
 * Effective monthly revenue in BigInt cents. Annual billers' price is
 * divided by 12 (integer floor — under by at most 11 cents per period).
 */
export function computeEffectiveMonthlyRevenue(
  tenant: TenantRevenueSnapshot,
  pricing: PricingTable = PRICING_FALLBACK,
): bigint {
  const base = pricing.base[tenant.tier_code];
  if (!base) throw new Error(`computeEffectiveMonthlyRevenue: unknown tier_code '${tenant.tier_code}'`);

  const seats = Math.max(1, tenant.seat_count);
  const period = tenant.billing_period;

  if (!AGENCY_TIERS.has(tenant.tier_code)) {
    const cents = period === "monthly" ? base.monthly : base.annual;
    return period === "monthly" ? BigInt(cents) : BigInt(cents) / 12n;
  }

  // Agency: base + ladder.
  const baseCents = BigInt(period === "monthly" ? base.monthly : base.annual);
  const ladderCents = ladderTotalCents(seats, period, pricing.seatLadder);
  const total = baseCents + ladderCents;
  return period === "monthly" ? total : total / 12n;
}

/**
 * Reference revenue for a tier = single-seat monthly price. Used by
 * §27.4.3+ dimensions to compute the per-tenant multiplier:
 *   multiplier = effective_monthly_revenue / tier_reference_revenue
 */
export function tierReferenceRevenueCents(
  tier_code: TenantTierCode,
  pricing: PricingTable = PRICING_FALLBACK,
): bigint {
  const base = pricing.base[tier_code];
  if (!base) throw new Error(`tierReferenceRevenueCents: unknown tier_code '${tier_code}'`);
  return BigInt(base.monthly);
}
