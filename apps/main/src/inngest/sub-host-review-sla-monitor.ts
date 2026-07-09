// #1165 — Sub-host review SLA monitor.
//
// Runs nightly. Platform commits to reviewing sub_host applications within
// 30 days of review_submitted_at (backfilled from created_at for pre-existing
// rows). Two actions:
//
//   Day 25 warning: sends operator alert listing tenants approaching the limit.
//   Day 30 auto-decline: terminates the tenant, cancels Stripe, emails applicant,
//                        emits tenant.terminated — same side-effects as a manual
//                        reject from the admin review UI.
//
// Outcome is idempotent: once status='terminated' the tenant no longer matches
// the 'onboarding' filter, so a re-run after a transient failure won't double-
// terminate.

import Stripe from "stripe";
import { escapeHtml } from "@/lib/utils";
import { inngest } from "./client";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { writeAuditLog } from "@/lib/audit/write";
import { sendOperatorNotification } from "@/lib/email/notifications";

const WARN_DAYS = 25;
const AUTO_DECLINE_DAYS = 30;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// Mirrors reviewEmailShell in admin/tenants/[id]/review/route.ts.
function reviewEmailShell(args: { heading: string; bodyHtml: string }): string {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f6f6f6;font-family:Arial,sans-serif;"><tbody><tr><td align="center" style="padding:24px 0;">
  <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;"><tbody>
    <tr><td style="padding:24px;background-color:#1f2937;">
      <h1 style="margin:0;color:#ffffff;font-size:20px;">AI Travel Concierge</h1>
    </td></tr>
    <tr><td style="padding:24px 32px;line-height:1.6;font-size:15px;color:#222222;">
      <h2 style="margin:0 0 16px 0;color:#1f2937;font-size:22px;">${args.heading}</h2>
      ${args.bodyHtml}
    </td></tr>
    <tr><td style="padding:16px 32px;background-color:#fafafa;border-top:1px solid #eeeeee;font-size:12px;color:#888888;">
      <p style="margin:0;">AI Travel Concierge &#8212; platform review team</p>
    </td></tr>
  </tbody></table>
</td></tr></tbody></table>`;
}

type ReviewRow = {
  id: string;
  legal_name: string | null;
  slug: string | null;
  stripe_subscription_id: string | null;
  review_submitted_at: string | null;
};

export const subHostReviewSlaMonitor = inngest.createFunction(
  {
    id: "sub-host-review-sla-monitor",
    triggers: [{ cron: "30 4 * * *" }], // daily at 04:30 UTC
  },
  async () => {
    if (process.env.STAGING_MODE === "true") return { skipped_for_staging: true };

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY not configured");
    const stripe = new Stripe(stripeKey);

    return withPlatformAdminAudit(
      {
        admin_user_id: "system-cron",
        reason: "tenant_review_sla_enforcement",
        operation: "sub_host_review_sla_monitor",
        reason_detail: `warn_at_${WARN_DAYS}d_decline_at_${AUTO_DECLINE_DAYS}d`,
      },
      async (db, recordQuery) => {
        const warnCutoff = daysAgo(WARN_DAYS);
        const declineCutoff = daysAgo(AUTO_DECLINE_DAYS);

        recordQuery({ op: "select", table: "tenants" });
        const candidates = (await safeAwait(
          db
            .from("tenants")
            .select("id, legal_name, slug, stripe_subscription_id, review_submitted_at")
            .eq("status", "onboarding")
            .eq("tenant_type", "sub_host")
            .eq("onboarding_stage", "review_submitted")
            .eq("is_platform_internal", false)
            // review_submitted_at is always set for review_submitted tenants
            // (stamped by progressTo; backfilled from created_at in migration 20260704000000).
            .lt("review_submitted_at", warnCutoff)
            .limit(200),
          "tenants.select.sub_host_review_sla_candidates",
        )) as ReviewRow[] | null;

        const rows = candidates ?? [];
        if (rows.length === 0) return { ok: true, warned: 0, declined: 0 };

        const toDecline = rows.filter(
          (r) => r.review_submitted_at && r.review_submitted_at < declineCutoff,
        );
        const toWarn = rows.filter(
          (r) => r.review_submitted_at && r.review_submitted_at >= declineCutoff,
        );

        // — Day-25 operator alert ——————————————————————————————————————————
        if (toWarn.length > 0) {
          const listHtml = toWarn
            .map(
              (r) =>
                `<li>${escapeHtml(r.legal_name ?? r.id)} (slug: ${escapeHtml(r.slug ?? "—")}, submitted: ${escapeHtml(r.review_submitted_at ?? "—")})</li>`,
            )
            .join("");
          await sendOperatorNotification({
            subject: `[Action required] ${toWarn.length} sub-host application(s) approaching 30-day review deadline`,
            html: `<p>${toWarn.length} sub-host application(s) have been in review for more than ${WARN_DAYS} days and will be auto-declined at ${AUTO_DECLINE_DAYS} days:</p><ul>${listHtml}</ul><p>Review them in the admin dashboard before the deadline to prevent auto-decline.</p>`,
            text: `${toWarn.length} sub-host application(s) approaching 30-day review limit: ${toWarn.map((r) => r.legal_name ?? r.id).join(", ")}`,
          });
        }

        // — Day-30 auto-decline ———————————————————————————————————————————
        let declined = 0;
        for (const tenant of toDecline) {
          // CAS-guarded: only terminates if still in onboarding (idempotent on retry).
          const updated = (await safeAwait(
            db
              .from("tenants")
              .update({
                status: "terminated",
                terminated_at: new Date().toISOString(),
                termination_kind: "involuntary_other",
                review_decision: "rejected",
                review_decision_reason: "Application not reviewed within 30 days — auto-declined by system.",
                review_decided_at: new Date().toISOString(),
              })
              .eq("id", tenant.id)
              .eq("status", "onboarding")
              .select("id"),
            "tenants.update.sub_host_auto_decline",
          )) as Array<{ id: string }> | null;

          if (!updated || updated.length !== 1) {
            // CAS loss: tenant status changed between SELECT and UPDATE (already
            // terminated or manually reviewed). Skip silently — not an error.
            console.info("[sub-host-review-sla-monitor] CAS skip tenant=%s (status changed)", tenant.id);
            continue;
          }
          declined++;
          recordQuery({ op: "update", table: "tenants" });

          // Cancel Stripe subscription before emailing (mirrors manual reject).
          if (tenant.stripe_subscription_id) {
            try {
              await stripe.subscriptions.cancel(tenant.stripe_subscription_id, { prorate: false });
            } catch (stripeErr) {
              console.warn(
                "[sub-host-review-sla-monitor] Stripe cancel failed tenant=%s: %s",
                tenant.id,
                stripeErr instanceof Error ? stripeErr.message : String(stripeErr),
              );
            }
          }

          // Notify applicant users (best-effort — must not block termination side-effects).
          try {
            const { data: users } = await db
              .from("users")
              .select("email")
              .eq("tenant_id", tenant.id)
              .eq("status", "active");
            const recipients = ((users ?? []) as Array<{ email: string }>).map((u) => u.email);

            const { sendTenantNotification } = await import("@/lib/email/notifications");
            for (const to of recipients) {
              await sendTenantNotification({
                db,
                tenant_id: tenant.id,
                to,
                subject: "Update on your AI Travel Concierge application",
                html: reviewEmailShell({
                  heading: "Your application was not approved",
                  bodyHtml: `<p>Unfortunately we were unable to complete the review of <strong>${escapeHtml(tenant.legal_name ?? "your agency")}</strong> within our standard timeframe.</p>
                    <p style="padding:12px 16px;background-color:#fef2f2;border-left:4px solid #ef4444;border-radius:4px;"><strong>Reason:</strong> Application not reviewed within 30 days &#8212; auto-declined by system.</p>
                    <p>If you believe this is an error, please contact us at support@ai-travelconcierge.com and we will re-open your application.</p>`,
                }),
                category: "transactional",
                template_id: "tenant_review_auto_declined",
                template_variables: {},
              });
            }
          } catch (notifyErr) {
            console.warn(
              "[sub-host-review-sla-monitor] notification failed tenant=%s: %s",
              tenant.id,
              notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
            );
          }

          await writeAuditLog(
            {
              tenant_id: tenant.id,
              actor_user_id: null,
              actor_type: "system",
              action: "tenant.auto_declined_review_sla",
              resource_type: "tenant",
              resource_id: tenant.id,
              changes: {
                slug: tenant.slug,
                review_submitted_at: tenant.review_submitted_at,
                auto_decline_threshold_days: AUTO_DECLINE_DAYS,
                cron_id: "sub-host-review-sla-monitor",
              },
            },
            { throwOnError: true },
          );

          // Emit termination side-effects (domain unbind, credential deletion, RAG cleanup).
          const { inngest: inngestClient } = await import("./client");
          await inngestClient.send({
            name: "tenant.terminated",
            data: { tenant_id: tenant.id, kind: "involuntary_other" },
          });

          console.info(
            "[sub-host-review-sla-monitor] auto-declined tenant=%s slug=%s submitted=%s",
            tenant.id,
            tenant.slug,
            tenant.review_submitted_at,
          );
        }

        return { ok: true, warned: toWarn.length, declined };
      },
    );
  },
);
