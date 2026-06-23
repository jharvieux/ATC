// §15.8 — Live pricing preview for tier selection page.
// Returns monthly or annual total for a given tier + seat count.
// For Agency: applies the §3.3 seat ladder.
//
// Prices come from the DB (tier_definitions price columns + pricing_seat_ladder,
// EPIC #1336) via loadPricingTable — the single source of truth. This is a
// public, pre-auth endpoint, so it reads the global pricing reference data via
// the service-role client (both tables are RLS-zero-policy + PLATFORM_READABLE);
// allowlisted in service-role-allowlist.js (§15.8).

import { calculateAgencySeatPreviewCents } from "@/lib/stripe/price-ids";
import type { BillingPeriod, Tier, TenantType } from "@/lib/stripe/price-ids";
import { TIER_CODE } from "@/lib/stripe/tier-codes";
import { loadPricingTable } from "@/lib/pricing/pricing-table";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

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

  const tierCode = TIER_CODE[tenantType]?.[tier];
  if (!tierCode) return Response.json({ error: "invalid_tier_for_tenant_type" }, { status: 422 });

  const pricing = await loadPricingTable(createServiceRoleClient());
  const basePrices = pricing.base[tierCode];
  const baseTotal = billingPeriod === "annual" ? basePrices.annual : basePrices.monthly;

  let additionalSeatCents = 0;
  if (tier === "agency" && seatCount > 1) {
    additionalSeatCents = calculateAgencySeatPreviewCents(seatCount - 1, billingPeriod, pricing.seatLadder);
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
