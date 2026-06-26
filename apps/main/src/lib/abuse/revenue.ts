// §27.4.1 / §3.3 — Effective monthly revenue computation.
//
// The single source of truth for what a tenant pays the platform per
// month, regardless of billing_period. Annual billers divide their annual
// price by 12. Multi-seat Agency tenants walk the §3.3 seat ladder.
//
// BigInt cents throughout. Callers must supply a PricingTable loaded from
// the DB via lib/pricing/pricing-table.ts — there is no code-level fallback.

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

// One seat-ladder band: prices seats up to (and including) `upTo`. The final
// band is open-ended — `upTo: Infinity` in the fallback, the INT4-max sentinel
// (2147483647) when loaded from the DB. Both compare correctly via Math.min.
export interface SeatBand {
  upTo: number;
  monthly: number;
  annual: number;
}

// The full pricing picture the compute functions need, loaded from the DB
// via lib/pricing/pricing-table.ts.
export interface PricingTable {
  base: Record<TenantTierCode, { monthly: number; annual: number }>;
  seatLadder: SeatBand[];
}

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
  pricing: PricingTable,
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
  pricing: PricingTable,
): bigint {
  const base = pricing.base[tier_code];
  if (!base) throw new Error(`tierReferenceRevenueCents: unknown tier_code '${tier_code}'`);
  return BigInt(base.monthly);
}
