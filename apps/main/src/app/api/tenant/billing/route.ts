// §15.15 — Subscription management console API.
// GET: current plan, invoice history.
// POST actions: change_tier, update_seats, switch_billing_period.
// Visible to tenant_billing_admin role only; read-only if pending_review or suspended.

import Stripe from "stripe";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { priceIdFor } from "@/lib/stripe/price-ids";
import { inngest } from "@/inngest/client";
import { withVendorHealthGate } from "@/lib/vendor-health/gate";
import type { TenantType, Tier, BillingPeriod } from "@/lib/stripe/price-ids";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  return new Stripe(key);
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "tenant.billing", action: "read" });
    const db = tenantClient(ctx);
    const { data: tenant, error } = await db
      .from("tenants")
      .select("stripe_subscription_id, stripe_customer_id, tier_id, seat_count, billing_period, status, pending_billing_period_change_effective_at")
      .eq("id", ctx.tenant_id)
      .single();

    if (error) return Response.json({ error: error.message }, { status: 500 });

    let invoices: unknown[] = [];
    if (tenant.stripe_customer_id) {
      try {
        const stripe = getStripe();
        const inv = await withVendorHealthGate("stripe", () =>
          stripe.invoices.list({
            customer: tenant.stripe_customer_id as string,
            limit: 24,
          }),
        );
        invoices = inv.data.map((i) => ({
          id: i.id,
          amount_due: i.amount_due,
          amount_paid: i.amount_paid,
          currency: i.currency,
          status: i.status,
          period_start: i.period_start,
          period_end: i.period_end,
          hosted_invoice_url: i.hosted_invoice_url,
        }));
      } catch {
        // Invoice fetch failure is non-fatal; return empty list.
      }
    }

    const isReadOnly = ["pending_review", "suspended"].includes(tenant.status ?? "");

    return Response.json({
      tenant,
      invoices,
      read_only: isReadOnly,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

interface BillingActionBody {
  action: "change_tier" | "update_seats" | "switch_billing_period";
  tier?: Tier;
  seat_count?: number;
  billing_period?: BillingPeriod;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "tenant.billing", action: "manage" });

    let body: BillingActionBody;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    const srDb = createServiceRoleClient();
    const { data: tenant, error: fetchErr } = await srDb
      .from("tenants")
      .select("stripe_subscription_id, stripe_customer_id, tier_id, seat_count, billing_period, status, tenant_type")
      .eq("id", ctx.tenant_id)
      .single();

    if (fetchErr || !tenant) {
      return Response.json({ error: fetchErr?.message ?? "not_found" }, { status: 500 });
    }

    if (["pending_review", "suspended"].includes(tenant.status ?? "")) {
      return Response.json({ error: "billing_read_only_in_current_status" }, { status: 403 });
    }

    const stripe = getStripe();

    if (body.action === "change_tier") {
      if (!body.tier) return Response.json({ error: "tier required" }, { status: 422 });

      const tenantType = tenant.tenant_type as TenantType;
      const billingPeriod = (tenant.billing_period ?? "monthly") as BillingPeriod;
      const newSeatCount = body.tier === "agency" ? Math.max(1, tenant.seat_count ?? 1) : 1;

      const basePriceId = priceIdFor({ tenant_type: tenantType, tier: body.tier, billing_period: billingPeriod, line_item: "base" });

      const items: Stripe.SubscriptionUpdateParams.Item[] = [
        { price: basePriceId, quantity: 1 },
      ];

      if (body.tier === "agency" && newSeatCount > 1) {
        const seatPriceId = priceIdFor({ tenant_type: tenantType, tier: "agency", billing_period: billingPeriod, line_item: "additional_seats" });
        items.push({ price: seatPriceId, quantity: newSeatCount - 1 });
      }

      if (tenant.stripe_subscription_id) {
        await stripe.subscriptions.update(tenant.stripe_subscription_id, {
          items,
          proration_behavior: "create_prorations",
          payment_behavior: "error_if_incomplete",
        });
      }

      // Resolve new tier_id.
      const { data: tierDef } = await srDb.from("tier_definitions").select("id").eq("slug", body.tier).maybeSingle();

      const db = tenantClient(ctx);
      await db.from("tenants").update({ tier_id: tierDef?.id ?? tenant.tier_id, seat_count: newSeatCount }).eq("id", ctx.tenant_id);

      await inngest.send({ name: "tenant.subscription_changed", data: { tenant_id: ctx.tenant_id, change: "tier", new_tier: body.tier } });
    } else if (body.action === "update_seats") {
      if (!body.seat_count) return Response.json({ error: "seat_count required" }, { status: 422 });

      const newSeatCount = Math.max(1, body.seat_count);
      const tenantType = tenant.tenant_type as TenantType;
      const billingPeriod = (tenant.billing_period ?? "monthly") as BillingPeriod;

      if (newSeatCount > 1) {
        const seatPriceId = priceIdFor({ tenant_type: tenantType, tier: "agency", billing_period: billingPeriod, line_item: "additional_seats" });
        if (tenant.stripe_subscription_id) {
          await stripe.subscriptions.update(tenant.stripe_subscription_id, {
            items: [{ price: seatPriceId, quantity: newSeatCount - 1 }],
            proration_behavior: "create_prorations",
            payment_behavior: "error_if_incomplete",
          });
        }
      }

      const db = tenantClient(ctx);
      await db.from("tenants").update({ seat_count: newSeatCount }).eq("id", ctx.tenant_id);

      await inngest.send({ name: "tenant.subscription_changed", data: { tenant_id: ctx.tenant_id, change: "seats", new_seat_count: newSeatCount } });
    } else if (body.action === "switch_billing_period") {
      if (!body.billing_period) return Response.json({ error: "billing_period required" }, { status: 422 });

      const currentPeriod = (tenant.billing_period ?? "monthly") as BillingPeriod;

      if (body.billing_period === currentPeriod) {
        return Response.json({ ok: true, billing_period: currentPeriod });
      }

      if (body.billing_period === "monthly" && currentPeriod === "annual") {
        // Annual → monthly: deferred to next renewal per §15.15.
        const db = tenantClient(ctx);
        let effectiveAt: string | null = null;
        if (tenant.stripe_subscription_id) {
          try {
            const sub = await withVendorHealthGate("stripe", () =>
              stripe.subscriptions.retrieve(tenant.stripe_subscription_id as string),
            );
            effectiveAt = new Date((sub as unknown as { current_period_end: number }).current_period_end * 1000).toISOString();
          } catch { /* non-fatal */ }
        }

        await db.from("tenants").update({ pending_billing_period_change_effective_at: effectiveAt }).eq("id", ctx.tenant_id);

        return Response.json({ ok: true, deferred: true, effective_at: effectiveAt });
      }

      // Monthly → annual: immediate proration upgrade.
      const tenantType = tenant.tenant_type as TenantType;
      const { data: tierDef } = await srDb.from("tier_definitions").select("slug").eq("id", tenant.tier_id).maybeSingle();
      const tier = (tierDef?.slug ?? "starter") as Tier;
      const basePriceId = priceIdFor({ tenant_type: tenantType, tier, billing_period: "annual", line_item: "base" });

      if (tenant.stripe_subscription_id) {
        await stripe.subscriptions.update(tenant.stripe_subscription_id, {
          items: [{ price: basePriceId, quantity: 1 }],
          proration_behavior: "create_prorations",
        });
      }

      const db = tenantClient(ctx);
      await db.from("tenants").update({ billing_period: "annual" }).eq("id", ctx.tenant_id);
    } else {
      return Response.json({ error: "unknown_action" }, { status: 422 });
    }

    return Response.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
