// §15.11 — Tenant review action: approve / reject / request_more_info.
// Every action wrapped in withPlatformAdminAudit.
//
// Approve:  status=active, activated_at, Stripe trial reset to 30 days, stage=complete.
// Reject:   status=terminated, review_decision=rejected, Stripe subscription cancelled.
// More info: review_decision=more_info_requested, onboarding_stage reverted to chosen stage.

import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { activateTenant } from "@/lib/tenants/activate-tenant";
import { revertTo, type OnboardingStage } from "@/lib/onboarding/state-machine";
import { inngest } from "@/inngest/client";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";

function escapeReviewHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// #975 — structured shell for the three review-decision emails. Table-based
// with inline styles (email-client-safe, same approach as BrandedLayout).
// These are platform→applicant transactional notices: platform header, no
// unsubscribe link.
function reviewEmailShell(args: {
  heading: string;
  bodyHtml: string;
  cta?: { href: string; label: string } | null;
}): string {
  const ctaHtml = args.cta
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:28px 0;"><tbody><tr><td align="center">
         <table role="presentation" cellspacing="0" cellpadding="0"><tbody><tr>
           <td style="border-radius:8px;background-color:#3b82f6;">
             <a href="${args.cta.href}" style="display:inline-block;padding:14px 32px;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;">${args.cta.label}</a>
           </td>
         </tr></tbody></table>
       </td></tr></tbody></table>`
    : "";
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f6f6f6;font-family:Arial,sans-serif;"><tbody><tr><td align="center" style="padding:24px 0;">
    <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;"><tbody>
      <tr><td style="padding:24px;background-color:#1f2937;">
        <h1 style="margin:0;color:#ffffff;font-size:20px;">AI Travel Concierge</h1>
      </td></tr>
      <tr><td style="padding:24px 32px;line-height:1.6;font-size:15px;color:#222222;">
        <h2 style="margin:0 0 16px 0;color:#1f2937;font-size:22px;">${args.heading}</h2>
        ${args.bodyHtml}
        ${ctaHtml}
      </td></tr>
      <tr><td style="padding:16px 32px;background-color:#fafafa;border-top:1px solid #eeeeee;font-size:12px;color:#888888;">
        <p style="margin:0;">AI Travel Concierge — platform review team</p>
      </td></tr>
    </tbody></table>
  </td></tr></tbody></table>`;
}

// Best-effort decision notification to the tenant's active users (#960).
// A send failure must not roll back the review decision, so errors are
// logged and swallowed. Callers invoke this BEFORE emitting lifecycle
// events as defensive ordering: no tenant.terminated handler mutates
// users.status today (verified 2026-06-10), but if one ever does, the
// recipient query here must already have run.
async function notifyTenantUsers(
  db: SupabaseClient,
  tenantId: string,
  email: {
    subject: string;
    html: string;
    template_id: string;
    template_variables: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const { data: users, error: usersErr } = await db
      .from("users")
      .select("email")
      .eq("tenant_id", tenantId)
      .eq("status", "active");
    // A failed read must be loggable, not indistinguishable from zero recipients —
    // on the reject path this is the only chance to email the applicant.
    if (usersErr) throw new Error(`users.select failed: ${usersErr.message}`);
    const recipients = ((users ?? []) as Array<{ email: string }>).map((u) => u.email);
    if (recipients.length === 0) return;
    const { sendTenantNotification } = await import("@/lib/email/notifications");
    for (const to of recipients) {
      await sendTenantNotification({
        db,
        tenant_id: tenantId,
        to,
        subject: email.subject,
        html: email.html,
        category: "transactional",
        template_id: email.template_id,
        template_variables: email.template_variables,
      });
    }
  } catch (notifyErr) {
    console.warn(
      "[admin/tenants/review] %s notification failed: %s",
      email.template_id,
      notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
    );
  }
}

interface ReviewBody {
  action: "approve" | "reject" | "request_more_info";
  reason?: string;
  revert_to_stage?: OnboardingStage;
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
          .select("id, legal_name, slug, stripe_subscription_id, stripe_customer_id, review_decision")
          .eq("id", tenantId)
          .single();

        if (fetchErr || !tenant) {
          throw new Error(fetchErr?.message ?? "Tenant not found");
        }

        if (body.action === "approve") {
          recordQuery({ op: "update", table: "tenants" });
          // CAS guard (#1189): only activates if onboarding_stage is still
          // "review_submitted", so a concurrent second approval finds 0 rows
          // and throws rather than double-stamping activated_at / re-firing
          // tenant.activated.
          await activateTenant(db, tenantId, {
            review_decision: "approved",
            review_decision_reason: body.reason ?? null,
            review_decided_at: new Date().toISOString(),
            review_decided_by_user_id: adminUserId,
          }, { casStage: "review_submitted" });

          // Reset Stripe trial to NOW + 30 days.
          if (tenant.stripe_subscription_id) {
            const trialEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
            await stripe.subscriptions.update(tenant.stripe_subscription_id, {
              trial_end: trialEnd,
            });
          }

          // Slug goes into an href unescaped — restrict to subdomain-safe chars
          // (escapeReviewHtml doesn't cover quotes/attribute contexts).
          const portalUrl =
            process.env.PLATFORM_PRIMARY_DOMAIN && /^[a-z0-9-]+$/.test(tenant.slug ?? "")
              ? `https://${tenant.slug}.${process.env.PLATFORM_PRIMARY_DOMAIN}/`
              : null;
          await notifyTenantUsers(db, tenantId, {
            subject: "Your AI Travel Concierge account is approved",
            html: reviewEmailShell({
              heading: "Your account has been approved 🎉",
              bodyHtml: `<p><strong>${escapeReviewHtml(tenant.legal_name ?? "Your agency")}</strong> has passed platform review and is now active.</p>
                <p>Your <strong>30-day trial starts today</strong>. ${
                  portalUrl
                    ? "Sign in to your agency portal to get started."
                    : "Sign in at your agency subdomain to get started."
                }</p>
                <p>If you skipped branding during onboarding, you can finish it any time from your settings.</p>`,
              cta: portalUrl ? { href: portalUrl, label: "Sign in to your agency portal →" } : null,
            }),
            template_id: "tenant_review_approved",
            template_variables: { portal_url: portalUrl ?? "" },
          });

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
              terminated_at: new Date().toISOString(),
              termination_kind: "involuntary_other",
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

          // Notify before tenant.terminated — defensive ordering: no handler
          // deactivates users rows today (verified 2026-06-10), but if one ever
          // does, the recipient query must already have run.
          await notifyTenantUsers(db, tenantId, {
            subject: "Update on your AI Travel Concierge application",
            html: reviewEmailShell({
              heading: "Your application was not approved",
              bodyHtml: `<p>After review, we are unable to approve <strong>${escapeReviewHtml(tenant.legal_name ?? "your agency")}</strong> at this time.</p>
                <p style="padding:12px 16px;background-color:#fef2f2;border-left:4px solid #ef4444;border-radius:4px;"><strong>Reason:</strong> ${escapeReviewHtml(body.reason ?? "See notes from the review team.")}</p>
                <p>If you believe this decision is in error, contact us at support@ai-travelconcierge.com.</p>`,
            }),
            template_id: "tenant_review_rejected",
            template_variables: { reason: body.reason ?? "" },
          });

          // §15.14.2 — run termination side-effects for the rejected applicant
          // (domain unbind, host-credential deletion, RAG chunk marking). This
          // path goes straight to terminated (never suspended), so we emit the
          // event directly rather than via the suspended→terminated finalizer.
          await inngest.send({
            name: "tenant.terminated",
            data: { tenant_id: tenantId, kind: "involuntary_other" },
          });
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

          await notifyTenantUsers(db, tenantId, {
            subject: "Action required: more information needed",
            html: reviewEmailShell({
              heading: "More information needed for your application",
              bodyHtml: `<p>Our review team needs more information before approving your account.</p>
                <p style="padding:12px 16px;background-color:#fffbeb;border-left:4px solid #f59e0b;border-radius:4px;"><strong>Reason:</strong> ${escapeReviewHtml(body.reason ?? "See notes from the reviewer.")}</p>
                <p>Please sign in and update the requested information in your onboarding flow.</p>`,
            }),
            template_id: "tenant_review_more_info",
            template_variables: { reason: body.reason ?? "" },
          });
        }
      },
    );

    return Response.json({ ok: true, action: body.action });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
