// §15.9 — Generate Stripe Connect account link for Connect setup stage.
// Creates or retrieves a Connect account and returns an account_link URL.

import Stripe from "stripe";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { respondToAuthError } from "@/lib/auth/respond";
import { tenantOriginFromRequest } from "@/lib/platform-url";

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

    const stripe = new Stripe(stripeKey);
    let connectAccountId = tenant?.stripe_connect_account_id;

    if (!connectAccountId) {
      const account = await stripe.accounts.create({
        type: "express",
        metadata: { tenant_id: ctx.tenant_id },
      });
      connectAccountId = account.id;

      const db = tenantClient(ctx);
      await safeAwait(
        db.from("tenants").update({ stripe_connect_account_id: connectAccountId }).eq("id", ctx.tenant_id),
        "tenants.update",
      );
    }

    // Tenant host, not the platform origin — see tenantOriginFromRequest.
    const baseUrl = tenantOriginFromRequest(req);

    const link = await stripe.accountLinks.create({
      account: connectAccountId,
      refresh_url: `${baseUrl}/onboarding/connect`,
      return_url: `${baseUrl}/onboarding/branding`,
      type: "account_onboarding",
    });

    return Response.json({ url: link.url });
  } catch (err) {
    return respondToAuthError(err);
  }
}
