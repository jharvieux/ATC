// §15.14.1 — Tenant termination handler.
// POST /api/admin/tenants/:id/terminate
// Body: { kind: 'voluntary' | 'involuntary_content' | 'involuntary_other', reason: string }
//
// Voluntary:   suspend → scheduled Inngest job terminates at suspension_end_at (90d).
// Involuntary: suspend immediately → Stripe cancel → delayed job terminates.
// Both paths write to audit_log and emit tenant.terminated event at final transition.

import Stripe from "stripe";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { inngest } from "@/inngest/client";

interface TerminateBody {
  kind: "voluntary" | "involuntary_content" | "involuntary_other";
  reason: string;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const adminUserId = req.headers.get("x-admin-user-id");
  if (!adminUserId) {
    return Response.json({ error: "x-admin-user-id header required" }, { status: 401 });
  }

  const { id: tenantId } = await params;

  let body: TerminateBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!["voluntary", "involuntary_content", "involuntary_other"].includes(body.kind)) {
    return Response.json({ error: "invalid_kind" }, { status: 422 });
  }

  if (!body.reason?.trim()) {
    return Response.json({ error: "reason required" }, { status: 422 });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return Response.json({ error: "stripe_not_configured" }, { status: 500 });
  }

  try {
    await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: "tenant_termination_processing",
        operation: `termination.${body.kind}`,
        reason_detail: body.reason,
      },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "tenants" });
        const { data: tenant, error: fetchErr } = await db
          .from("tenants")
          .select("id, stripe_subscription_id, status")
          .eq("id", tenantId)
          .single();

        if (fetchErr || !tenant) throw new Error(fetchErr?.message ?? "Tenant not found");

        const suspensionEndAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

        recordQuery({ op: "update", table: "tenants" });
        const { error: updateErr } = await db.from("tenants").update({
          status: "suspended",
          suspended_at: new Date().toISOString(),
          suspended_reason: `termination_initiated_${body.kind}`,
          termination_kind: body.kind,
          terminated_reason: body.reason,
          termination_initiated_by_user_id: adminUserId,
          suspension_end_at: suspensionEndAt,
        }).eq("id", tenantId);

        if (updateErr) throw new Error(updateErr.message);

        const stripe = new Stripe(stripeKey);

        if (body.kind === "voluntary") {
          // Cancel at period end — billing continues through the current period.
          if (tenant.stripe_subscription_id) {
            await stripe.subscriptions.update(tenant.stripe_subscription_id, {
              cancel_at_period_end: true,
            });
          }
        } else if (body.kind === "involuntary_content") {
          // Immediate cancel, no proration.
          if (tenant.stripe_subscription_id) {
            await stripe.subscriptions.cancel(tenant.stripe_subscription_id, { prorate: false });
          }
        } else {
          // involuntary_other: immediate cancel with proration refund.
          if (tenant.stripe_subscription_id) {
            await stripe.subscriptions.cancel(tenant.stripe_subscription_id, { prorate: true });
          }
        }

        // Schedule the final termination after 90 days.
        await inngest.send({
          name: "tenant.termination_scheduled",
          data: {
            tenant_id: tenantId,
            kind: body.kind,
            terminate_at: suspensionEndAt,
            admin_user_id: adminUserId,
          },
        });

        // TODO(notifications): email tenant with termination notice.
      },
    );

    return Response.json({ ok: true, kind: body.kind });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
