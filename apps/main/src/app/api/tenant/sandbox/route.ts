// §15.12 — Sandbox mode toggle.
// GET: returns current sandbox state.
// POST: toggles is_sandbox. Pauses/unpauses Stripe subscription.
// Switching back to live requires explicit confirmation checkbox.

import Stripe from "stripe";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { respondToAuthError } from "@/lib/auth/respond";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "tenant.sandbox", action: "read" });
    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("tenants")
      .select("is_sandbox")
      .eq("id", ctx.tenant_id)
      .single();

    if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });

    return Response.json({ is_sandbox: data.is_sandbox });
  } catch (err) {
    return respondToAuthError(err);
  }
}

interface SandboxToggleBody {
  enable: boolean;
  // Required when enabling = false (switching back to live).
  confirmed_live_mode?: boolean;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "tenant.sandbox", action: "toggle" });

    let body: SandboxToggleBody;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    // Switching back to live requires explicit confirmation per §15.12.
    if (!body.enable && !body.confirmed_live_mode) {
      return Response.json({ error: "confirmed_live_mode_required_to_exit_sandbox" }, { status: 422 });
    }

    const srDb = createServiceRoleClient();
    const { data: tenant, error: fetchErr } = await srDb
      .from("tenants")
      .select("stripe_subscription_id, is_sandbox")
      .eq("id", ctx.tenant_id)
      .single();

    if (fetchErr || !tenant) {
      return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    }

    // No-op if already in desired state.
    if (tenant.is_sandbox === body.enable) {
      return Response.json({ is_sandbox: body.enable });
    }

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return Response.json({ error: "stripe_not_configured" }, { status: 500 });
    }
    const stripe = new Stripe(stripeKey);

    if (body.enable) {
      // Entering sandbox: pause Stripe subscription billing.
      if (tenant.stripe_subscription_id) {
        await stripe.subscriptions.update(tenant.stripe_subscription_id, {
          pause_collection: { behavior: "void" },
        });
      }
    } else {
      // Exiting sandbox: resume Stripe subscription billing.
      if (tenant.stripe_subscription_id) {
        await stripe.subscriptions.update(tenant.stripe_subscription_id, {
          pause_collection: "",
        } as Parameters<typeof stripe.subscriptions.update>[1]);
      }
    }

    const db = tenantClient(ctx);
    const { error } = await db
      .from("tenants")
      .update({ is_sandbox: body.enable })
      .eq("id", ctx.tenant_id);

    if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });

    return Response.json({ is_sandbox: body.enable });
  } catch (err) {
    return respondToAuthError(err);
  }
}
