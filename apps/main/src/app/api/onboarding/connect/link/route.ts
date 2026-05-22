// §15.9 — Generate Stripe Connect account link for Connect setup stage.
// Returns a fresh account_link URL to the existing Connect account.

import Stripe from "stripe";
import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "onboarding", action: "connect:setup" });

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return Response.json({ error: "stripe_not_configured" }, { status: 500 });

    const srDb = createServiceRoleClient();
    const { data: tenant } = await srDb
      .from("tenants")
      .select("stripe_connect_account_id")
      .eq("id", ctx.tenant_id)
      .single();

    if (!tenant?.stripe_connect_account_id) {
      return Response.json({ error: "connect_account_not_created" }, { status: 409 });
    }

    const stripe = new Stripe(stripeKey);
    const baseUrl = process.env.PLATFORM_PRIMARY_DOMAIN
      ? `https://${process.env.PLATFORM_PRIMARY_DOMAIN}`
      : "https://localhost:3000";

    const link = await stripe.accountLinks.create({
      account: tenant.stripe_connect_account_id,
      refresh_url: `${baseUrl}/onboarding/connect`,
      return_url: `${baseUrl}/onboarding/branding`,
      type: "account_onboarding",
    });

    return Response.json({ url: link.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
