// §15.8 — Stripe Checkout session for subscription setup.
// trial_end is set to 729 days from now (Stripe's max is 730) as a placeholder per §15.8.
// Admin approval resets it to NOW + 30 days.
// payment_behavior = 'allow_incomplete' so billing doesn't run pre-activation.

import Stripe from "stripe";
import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { priceIdFor } from "@/lib/stripe/price-ids";
import type { TenantType, BillingPeriod } from "@/lib/stripe/price-ids";
import { respondToAuthError } from "@/lib/auth/respond";
import { CODE_TO_TIER } from "@/lib/stripe/tier-codes";
import { tenantOriginFromRequest } from "@/lib/platform-url";

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

    const tier = CODE_TO_TIER[tierDef.code as keyof typeof CODE_TO_TIER];
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

    // Tenant host, not the platform origin — Stripe must redirect back to the
    // subdomain/custom domain so onboarding APIs resolve the real tenant_id.
    const baseUrl = tenantOriginFromRequest(req);

    const sessionParams: Parameters<typeof stripe.checkout.sessions.create>[0] = {
      mode: "subscription",
      line_items: lineItems,
      ...(tenant.stripe_customer_id ? { customer: tenant.stripe_customer_id } : {}),
      subscription_data: {
        trial_end: trialEnd,
        metadata: { tenant_id: ctx.tenant_id },
      },
      metadata: { tenant_id: ctx.tenant_id },
      // BYO hosts skip connect_setup (payouts are sub-host-only); send them
      // straight to branding. Routing them to /onboarding/connect stranded
      // them on the Set Up Payouts page (advanceByo only rescues the
      // connect_setup stage, which BYO hosts never reach).
      success_url: `${baseUrl}/onboarding/${tenantType === "byo_host" ? "branding" : "connect"}`,
      cancel_url: `${baseUrl}/onboarding/subscription`,
    };

    const session = await stripe.checkout.sessions.create(sessionParams);

    return Response.json({ url: session.url });
  } catch (err) {
    return respondToAuthError(err);
  }
}
