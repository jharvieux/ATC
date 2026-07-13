// §15.15 — Subscription management console API.
// GET: current plan, invoice history.
// POST actions: change_tier, update_seats, switch_billing_period.
// Visible to tenant_billing_admin role only; read-only if pending_review or suspended.

import Stripe from "stripe";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { priceIdFor, loadPriceMap } from "@/lib/stripe/price-ids";
import { inngest } from "@/inngest/client";
import { withVendorHealthGate } from "@/lib/vendor-health/gate";
import type { TenantType, Tier, BillingPeriod } from "@/lib/stripe/price-ids";
import { respondToAuthError } from "@/lib/auth/respond";
import { safeAwait } from "@/lib/db/safe-mutation";
import { TIER_CODE, CODE_TO_TIER } from "@/lib/stripe/tier-codes";

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

    if (error) {
      const ref = crypto.randomUUID();
      console.error(`[billing] tenant_fetch_failed ref=${ref}:`, error.message);
      return Response.json({ error: "tenant_fetch_failed", ref }, { status: 500 });
    }

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
      } catch (err) {
        console.error("[billing] Stripe invoice fetch failed", { tenant_id: ctx.tenant_id, error: String(err) });
        // non-fatal — return empty list
      }
    }

    const isReadOnly = ["pending_review", "suspended"].includes(tenant.status ?? "");

    // #444 — seat management is Agency-only (§15.15); the page needs the
    // tier resolved server-side. Lookup failure degrades to false (seats UI
    // hidden), matching the non-fatal invoice-fetch stance above.
    let isAgency = false;
    if (tenant.tier_id) {
      const { data: tierDef, error: tierErr } = await db
        .from("tier_definitions")
        .select("code")
        .eq("id", tenant.tier_id)
        .maybeSingle();
      if (tierErr) {
        console.error(`[billing] tier_code_fetch_failed tenant=${ctx.tenant_id}:`, tierErr.message);
      }
      isAgency = CODE_TO_TIER[tierDef?.code as keyof typeof CODE_TO_TIER] === "agency";
    }

    return Response.json({
      tenant,
      invoices,
      read_only: isReadOnly,
      is_agency: isAgency,
    });
  } catch (err) {
    return respondToAuthError(err);
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
      const ref = crypto.randomUUID();
      console.error(`[billing] tenant_fetch_failed ref=${ref}:`, fetchErr?.message ?? "not_found");
      return Response.json({ error: "tenant_fetch_failed", ref }, { status: 500 });
    }

    if (["pending_review", "suspended"].includes(tenant.status ?? "")) {
      return Response.json({ error: "billing_read_only_in_current_status" }, { status: 403 });
    }

    const stripe = getStripe();
    const priceMap = await loadPriceMap(srDb);

    if (body.action === "change_tier") {
      if (!body.tier) return Response.json({ error: "tier required" }, { status: 422 });

      const tenantType = tenant.tenant_type as TenantType;
      const billingPeriod = (tenant.billing_period ?? "monthly") as BillingPeriod;
      const newSeatCount = body.tier === "agency" ? Math.max(1, tenant.seat_count ?? 1) : 1;

      const basePriceId = priceIdFor({ tenant_type: tenantType, tier: body.tier, billing_period: billingPeriod, line_item: "base" }, priceMap);

      const items: Stripe.SubscriptionUpdateParams.Item[] = [
        { price: basePriceId, quantity: 1 },
      ];

      if (body.tier === "agency" && newSeatCount > 1) {
        const seatPriceId = priceIdFor({ tenant_type: tenantType, tier: "agency", billing_period: billingPeriod, line_item: "additional_seats" }, priceMap);
        items.push({ price: seatPriceId, quantity: newSeatCount - 1 });
      }

      if (tenant.stripe_subscription_id) {
        await stripe.subscriptions.update(tenant.stripe_subscription_id, {
          items,
          proration_behavior: "create_prorations",
          payment_behavior: "error_if_incomplete",
        });
      }

      // Resolve new tier_id via type-prefixed code (§3.3).
      const newTierCode = TIER_CODE[tenantType]?.[body.tier as Tier];
      if (!newTierCode) return Response.json({ error: "invalid_tier_for_tenant_type" }, { status: 422 });
      const { data: newTierDef, error: newTierErr } = await srDb.from("tier_definitions").select("id").eq("code", newTierCode).maybeSingle();
      if (newTierErr) {
        const ref = crypto.randomUUID();
        console.error(`[billing] tier_lookup_failed ref=${ref}:`, newTierErr.message);
        return Response.json({ error: "tier_lookup_failed", ref }, { status: 500 });
      }
      if (!newTierDef) return Response.json({ error: "tier_definition_missing" }, { status: 500 });

      const db = tenantClient(ctx);
      await safeAwait(db.from("tenants").update({ tier_id: newTierDef.id, seat_count: newSeatCount }).eq("id", ctx.tenant_id), "tenants.update");

      await inngest.send({ name: "tenant.subscription_changed", data: { tenant_id: ctx.tenant_id, change: "tier", new_tier: body.tier } });
    } else if (body.action === "update_seats") {
      if (!body.seat_count) return Response.json({ error: "seat_count required" }, { status: 422 });

      // #444 — seat management is Agency-only (§15.15). Without this gate a
      // non-agency tenant could attach the agency seat price to its own
      // subscription. Fail-closed: lookup error → 500, non-agency → 422.
      const { data: seatTierDef, error: seatTierErr } = await srDb
        .from("tier_definitions")
        .select("code")
        .eq("id", tenant.tier_id)
        .maybeSingle();
      if (seatTierErr) {
        const ref = crypto.randomUUID();
        console.error(`[billing] tier_lookup_failed ref=${ref}:`, seatTierErr.message);
        return Response.json({ error: "tier_lookup_failed", ref }, { status: 500 });
      }
      if (CODE_TO_TIER[seatTierDef?.code as keyof typeof CODE_TO_TIER] !== "agency") {
        return Response.json({ error: "seats_agency_tier_only" }, { status: 422 });
      }

      const newSeatCount = Math.max(1, body.seat_count);
      const tenantType = tenant.tenant_type as TenantType;
      const billingPeriod = (tenant.billing_period ?? "monthly") as BillingPeriod;

      if (newSeatCount > 1) {
        const seatPriceId = priceIdFor({ tenant_type: tenantType, tier: "agency", billing_period: billingPeriod, line_item: "additional_seats" }, priceMap);
        if (tenant.stripe_subscription_id) {
          await stripe.subscriptions.update(tenant.stripe_subscription_id, {
            items: [{ price: seatPriceId, quantity: newSeatCount - 1 }],
            proration_behavior: "create_prorations",
            payment_behavior: "error_if_incomplete",
          });
        }
      }

      const db = tenantClient(ctx);
      await safeAwait(db.from("tenants").update({ seat_count: newSeatCount }).eq("id", ctx.tenant_id), "tenants.update");

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
          } catch (err) {
            console.error("[billing] Stripe subscription retrieval failed", { tenant_id: ctx.tenant_id, stripe_subscription_id: tenant.stripe_subscription_id, error: String(err) });
            // non-fatal — effective_at falls back to inferred date
          }
        }

        await safeAwait(db.from("tenants").update({ pending_billing_period_change_effective_at: effectiveAt }).eq("id", ctx.tenant_id), "tenants.update");

        return Response.json({ ok: true, deferred: true, effective_at: effectiveAt });
      }

      // Monthly → annual: immediate proration upgrade.
      const tenantType = tenant.tenant_type as TenantType;
      const { data: tierDef, error: tierErr } = await srDb.from("tier_definitions").select("code").eq("id", tenant.tier_id).maybeSingle();
      if (tierErr) {
        const ref = crypto.randomUUID();
        console.error(`[billing] tier_lookup_failed ref=${ref}:`, tierErr.message);
        return Response.json({ error: "tier_lookup_failed", ref }, { status: 500 });
      }
      if (!tierDef) return Response.json({ error: "tier_definition_missing" }, { status: 500 });
      const tier = CODE_TO_TIER[tierDef.code as keyof typeof CODE_TO_TIER];
      if (!tier) return Response.json({ error: "unrecognized_tier_code" }, { status: 500 });
      const basePriceId = priceIdFor({ tenant_type: tenantType, tier, billing_period: "annual", line_item: "base" }, priceMap);

      if (tenant.stripe_subscription_id) {
        await stripe.subscriptions.update(tenant.stripe_subscription_id, {
          items: [{ price: basePriceId, quantity: 1 }],
          proration_behavior: "create_prorations",
        });
      }

      const db = tenantClient(ctx);
      await safeAwait(db.from("tenants").update({ billing_period: "annual" }).eq("id", ctx.tenant_id), "tenants.update");
    } else {
      return Response.json({ error: "unknown_action" }, { status: 422 });
    }

    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}
