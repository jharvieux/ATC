// §15.6 — Generate Stripe Connect onboarding link for tax form stage.
// Creates or retrieves a Connect account and returns an account_link URL.
// NOTE: In Stripe's Express onboarding, tax forms (W-9/W-8BEN) are part
// of the broader account onboarding. Stage 5 (tax_form) and Stage 9
// (connect_setup) share the same Stripe Express flow; the webhook
// distinguishes them by checking which stage fields are satisfied.
// See MEMORY D-049 for the merge decision.

import Stripe from "stripe";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { respondToAuthError } from "@/lib/auth/respond";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "onboarding", action: "tax_form:start" });

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return Response.json({ error: "stripe_not_configured" }, { status: 500 });

    const srDb = createServiceRoleClient();
    const { data: tenant } = await srDb
      .from("tenants")
      .select("stripe_connect_account_id, support_email, display_name")
      .eq("id", ctx.tenant_id)
      .single();

    const stripe = new Stripe(stripeKey);
    let connectAccountId = tenant?.stripe_connect_account_id;

    if (!connectAccountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: tenant?.support_email ?? undefined,
        metadata: { tenant_id: ctx.tenant_id },
      });
      connectAccountId = account.id;

      const db = tenantClient(ctx);
      await safeAwait(db.from("tenants").update({ stripe_connect_account_id: connectAccountId }).eq("id", ctx.tenant_id), "tenants.update");
    }

    const baseUrl = process.env.PLATFORM_PRIMARY_DOMAIN
      ? `https://${process.env.PLATFORM_PRIMARY_DOMAIN}`
      : "https://localhost:3000";

    const link = await stripe.accountLinks.create({
      account: connectAccountId,
      refresh_url: `${baseUrl}/onboarding/tax-form`,
      return_url: `${baseUrl}/onboarding/tax-form`,
      type: "account_onboarding",
    });

    return Response.json({ url: link.url });
  } catch (err) {
    return respondToAuthError(err);
  }
}
