// §15.8 — Stripe Checkout session for subscription setup.
// trial_end is set to 729 days from now (Stripe's max is 730) as a placeholder per §15.8.
// Admin approval resets it to NOW + 30 days.
// payment_behavior = 'allow_incomplete' so billing doesn't run pre-activation.

import Stripe from "stripe";
import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { priceIdFor } from "@/lib/stripe/price-ids";
import type { TenantType, Tier, BillingPeriod } from "@/lib/stripe/price-ids";
import { respondToAuthError } from "@/lib/auth/respond";

// Maps tier_definitions.code (type-prefixed) → bare Tier for priceIdFor (§3.3 / §15.8).
const CODE_TO_TIER: Record<string, Tier> = {
  byo_research:     "starter",
  byo_professional: "pro",
  byo_agency:       "agency",
  sub_starter:      "starter",
  sub_pro:          "pro",
  sub_agency:       "agency",
};

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "onboarding", action: "subscription:setup" });

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return Response.json({ error: "stripe_not_configured" }, { status: 500 });

    const srDb = createServiceRoleClient();
    const { data: tenant, error } = await srDb
      .from("tenants")
      .select("id, tenant_type, tier_id, seat_count, billing_period, stripe_customer_id")
      .eq("id", ctx.tenant_id)
      .single();

    if (error || !tenant) return Response.json({ error: error?.message ?? "not_found" }, { status: 500 });

    const { data: tierDef, error: tierErr } = await srDb
      .from("tier_definitions")
      .select("code")
      .eq("id", tenant.tier_id)
      .maybeSingle();

    if (tierErr) return Response.json({ error: tierErr.message }, { status: 500 });
    if (!tierDef) return Response.json({ error: "tier_definition_missing" }, { status: 500 });

    const tier = CODE_TO_TIER[tierDef.code];
    if (!tier) return Response.json({ error: "unrecognized_tier_code" }, { status: 500 });
    const tenantType = tenant.tenant_type as TenantType;
    const billingPeriod = (tenant.billing_period ?? "monthly") as BillingPeriod;
    const seatCount = tenant.seat_count ?? 1;

    const lineItems = [
      { price: priceIdFor({ tenant_type: tenantType, tier, billing_period: billingPeriod, line_item: "base" }), quantity: 1 },
    ];

    if (tier === "agency" && seatCount > 1) {
      lineItems.push({
        price: priceIdFor({ tenant_type: tenantType, tier, billing_period: billingPeriod, line_item: "additional_seats" }),
        quantity: seatCount - 1,
      });
    }

    const stripe = new Stripe(stripeKey);
    // Stripe Checkout max trial is 730 days; use 729 as placeholder until admin approval resets to NOW+30d.
    const trialEnd = Math.floor(Date.now() / 1000) + 729 * 24 * 60 * 60;

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

    const sessionParams: Parameters<typeof stripe.checkout.sessions.create>[0] = {
      mode: "subscription",
      line_items: lineItems,
      ...(tenant.stripe_customer_id ? { customer: tenant.stripe_customer_id } : {}),
      subscription_data: {
        trial_end: trialEnd,
        metadata: { tenant_id: ctx.tenant_id },
      },
      metadata: { tenant_id: ctx.tenant_id },
      success_url: `${baseUrl}/onboarding/connect`,
      cancel_url: `${baseUrl}/onboarding/subscription`,
    };

    const session = await stripe.checkout.sessions.create(sessionParams);

    return Response.json({ url: session.url });
  } catch (err) {
    return respondToAuthError(err);
  }
}
