// §15.8 — Live pricing preview for tier selection page.
// Returns monthly or annual total for a given tier + seat count.
// For Agency: applies the §3.3 seat ladder ($59/$49/$39/seat/month).
// Annual = monthly × 10 (2 months free, per pricing model).

import { calculateAgencySeatPreviewCents } from "@/lib/stripe/price-ids";
import type { BillingPeriod, Tier, TenantType } from "@/lib/stripe/price-ids";

const FLAT_RATES_MONTHLY_CENTS: Record<TenantType, Partial<Record<Tier, number>>> = {
  sub_host: {
    starter: 9900,  // $99/month placeholder — actual value from Stripe
    pro:     19900, // $199/month placeholder
    agency:  29900, // $299/month base placeholder
  },
  byo_host: {
    starter: 4900,  // $49/month placeholder
    pro:     9900,  // $99/month placeholder
    agency:  19900, // $199/month placeholder
  },
};

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const tier = url.searchParams.get("tier") as Tier | null;
  const billingPeriod = url.searchParams.get("billing_period") as BillingPeriod | null;
  const seats = parseInt(url.searchParams.get("seats") ?? "1", 10);
  const tenantType = (url.searchParams.get("tenant_type") ?? "sub_host") as TenantType;

  if (!tier || !billingPeriod) {
    return Response.json({ error: "tier and billing_period are required" }, { status: 400 });
  }

  if (!["monthly", "annual"].includes(billingPeriod)) {
    return Response.json({ error: "invalid billing_period" }, { status: 400 });
  }

  if (!["starter", "pro", "agency"].includes(tier)) {
    return Response.json({ error: "invalid tier" }, { status: 400 });
  }

  const seatCount = isNaN(seats) || seats < 1 ? 1 : seats;

  const baseMonthly = FLAT_RATES_MONTHLY_CENTS[tenantType]?.[tier] ?? 0;
  const baseTotal = billingPeriod === "annual" ? baseMonthly * 10 : baseMonthly;

  let additionalSeatCents = 0;
  if (tier === "agency" && seatCount > 1) {
    additionalSeatCents = calculateAgencySeatPreviewCents(seatCount - 1, billingPeriod);
  }

  const totalCents = baseTotal + additionalSeatCents;

  return Response.json({
    tier,
    billing_period: billingPeriod,
    seat_count: seatCount,
    total_cents: totalCents,
    base_cents: baseTotal,
    additional_seat_cents: additionalSeatCents,
    currency: "USD",
  });
}
