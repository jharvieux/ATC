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
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { publishTenantShadowEvent } from "@/lib/rag-sync/publish-tenant-shadow-event";
import { dbErrorResponse } from "@/lib/api/db-error-response";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface TerminateBody {
  kind: "voluntary" | "involuntary_content" | "involuntary_other";
  reason: string;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "tenants")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
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

        // Propagate the suspension to RAG so retrieval is cut off during the
        // grace window (best-effort; never throws, reconcile backstops).
        await publishTenantShadowEvent(db, tenantId, "tenant.status_changed");

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

        // Notify the tenant. Best-effort — termination already committed.
        try {
          const { data: ownerRows } = await db
            .from("users")
            .select("email")
            .eq("tenant_id", tenantId)
            .eq("status", "active");
          const owners = (ownerRows ?? []) as Array<{ email: string }>;
          if (owners.length > 0) {
            const { sendTenantNotification } = await import(
              "@/lib/email/notifications"
            );
            const kindLabel =
              body.kind === "voluntary"
                ? "voluntarily closed"
                : body.kind === "involuntary_content"
                  ? "terminated for content-policy reasons"
                  : "terminated";
            const html = `
              <h2>Your AI Travel Concierge account has been ${kindLabel}.</h2>
              <p>${escapeHtml(body.reason)}</p>
              <p>Your account is now suspended. Data will be permanently
              deleted on <strong>${escapeHtml(suspensionEndAt.slice(0, 10))}</strong>.</p>
              <p>If you believe this is in error, reply to this email within
              the 90-day window to appeal.</p>
            `;
            for (const owner of owners) {
              await sendTenantNotification({
                db,
                tenant_id: tenantId,
                to: owner.email,
                subject: "Your account has been terminated",
                html,
                category: "transactional",
                template_id: "tenant_termination_notice",
                template_variables: {
                  kind: body.kind,
                  reason: body.reason,
                  termination_at: suspensionEndAt,
                },
              });
            }
          }
        } catch (notifyErr) {
          console.warn(
            "[admin/tenants/terminate] notification failed: %s",
            notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
          );
        }
      },
    );

    return Response.json({ ok: true, kind: body.kind });
  } catch (err) {
    return dbErrorResponse(err);
  }
}
