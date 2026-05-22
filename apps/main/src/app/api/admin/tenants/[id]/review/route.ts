// §15.11 — Tenant review action: approve / reject / request_more_info.
// Every action wrapped in withPlatformAdminAudit.
//
// Approve:  status=active, activated_at, Stripe trial reset to 30 days, stage=complete.
// Reject:   status=terminated, review_decision=rejected, Stripe subscription cancelled.
// More info: review_decision=more_info_requested, onboarding_stage reverted to chosen stage.

import Stripe from "stripe";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { revertTo, type OnboardingStage } from "@/lib/onboarding/state-machine";
import { inngest } from "@/inngest/client";

interface ReviewBody {
  action: "approve" | "reject" | "request_more_info";
  reason?: string;
  revert_to_stage?: OnboardingStage;
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

  let body: ReviewBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!["approve", "reject", "request_more_info"].includes(body.action)) {
    return Response.json({ error: "invalid_action" }, { status: 422 });
  }

  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY not configured");
    const stripe = new Stripe(stripeKey);

    await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: "onboarding_review_action",
        operation: `onboarding.review.${body.action}`,
        ...(body.reason ? { reason_detail: body.reason } : {}),
      },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "tenants" });
        const { data: tenant, error: fetchErr } = await db
          .from("tenants")
          .select("id, stripe_subscription_id, stripe_customer_id, review_decision")
          .eq("id", tenantId)
          .single();

        if (fetchErr || !tenant) {
          throw new Error(fetchErr?.message ?? "Tenant not found");
        }

        if (body.action === "approve") {
          recordQuery({ op: "update", table: "tenants" });
          const { error } = await db
            .from("tenants")
            .update({
              status: "active",
              activated_at: new Date().toISOString(),
              review_decision: "approved",
              review_decision_reason: body.reason ?? null,
              review_decided_at: new Date().toISOString(),
              review_decided_by_user_id: adminUserId,
              onboarding_stage: "complete",
            })
            .eq("id", tenantId);

          if (error) throw new Error(error.message);

          // Reset Stripe trial to NOW + 30 days.
          if (tenant.stripe_subscription_id) {
            const trialEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
            await stripe.subscriptions.update(tenant.stripe_subscription_id, {
              trial_end: trialEnd,
            });
          }

          await inngest.send({
            name: "tenant.activated",
            data: { tenant_id: tenantId, admin_user_id: adminUserId },
          });
        } else if (body.action === "reject") {
          recordQuery({ op: "update", table: "tenants" });
          const { error } = await db
            .from("tenants")
            .update({
              status: "terminated",
              review_decision: "rejected",
              review_decision_reason: body.reason ?? null,
              review_decided_at: new Date().toISOString(),
              review_decided_by_user_id: adminUserId,
            })
            .eq("id", tenantId);

          if (error) throw new Error(error.message);

          // Cancel Stripe subscription (if exists).
          if (tenant.stripe_subscription_id) {
            await stripe.subscriptions.cancel(tenant.stripe_subscription_id, { prorate: false });
          }
        } else if (body.action === "request_more_info") {
          if (!body.revert_to_stage) {
            throw new Error("revert_to_stage is required for request_more_info");
          }

          recordQuery({ op: "update", table: "tenants" });
          const { error } = await db
            .from("tenants")
            .update({
              review_decision: "more_info_requested",
              review_decision_reason: body.reason ?? null,
              review_decided_at: new Date().toISOString(),
              review_decided_by_user_id: adminUserId,
            })
            .eq("id", tenantId);

          if (error) throw new Error(error.message);

          await revertTo(tenantId, body.revert_to_stage);
          // TODO(notifications): send tenant notification that more info is needed.
        }
      },
    );

    return Response.json({ ok: true, action: body.action });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
