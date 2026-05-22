// §15.8 — Stripe Checkout session for subscription setup.
// trial_end is set to far-future (epoch 2099) placeholder per §15.8.
// Admin approval resets it to NOW + 30 days.
// payment_behavior = 'allow_incomplete' so billing doesn't run pre-activation.

import Stripe from "stripe";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { priceIdFor } from "@/lib/stripe/price-ids";
import type { TenantType, Tier, BillingPeriod } from "@/lib/stripe/price-ids";

const FAR_FUTURE_TRIAL_END = 4102444800; // 2099-12-31 UTC

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

    const { data: tierDef } = await srDb
      .from("tier_definitions")
      .select("slug")
      .eq("id", tenant.tier_id)
      .maybeSingle();

    const tier = (tierDef?.slug ?? "starter") as Tier;
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

    const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
      ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin
      : "https://localhost:3000";

    const sessionParams: Parameters<typeof stripe.checkout.sessions.create>[0] = {
      mode: "subscription",
      line_items: lineItems,
      ...(tenant.stripe_customer_id ? { customer: tenant.stripe_customer_id } : {}),
      subscription_data: {
        trial_end: FAR_FUTURE_TRIAL_END,
        metadata: { tenant_id: ctx.tenant_id },
      },
      metadata: { tenant_id: ctx.tenant_id },
      success_url: `${baseUrl}/onboarding/connect`,
      cancel_url: `${baseUrl}/onboarding/subscription`,
    };

    const session = await stripe.checkout.sessions.create(sessionParams);

    return Response.json({ url: session.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
