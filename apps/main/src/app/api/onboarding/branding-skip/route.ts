// §15.10 — Onboarding Stage 10: Skip branding step.
//
// BYO hosts (tenant_type="byo_host") are NOT subject to platform review — they
// bring their own host relationship, so completing onboarding activates them
// immediately (status="active", onboarding_stage="complete"). They never reach
// the "awaiting review" screen.
//
// Sub-hosts still advance to review_submitted to await platform-admin approval.

import { assertPermission } from "@/lib/auth/assert-permission";
import { progressTo } from "@/lib/onboarding/state-machine";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { safeAwaitRowCount } from "@/lib/db/safe-mutation";
import type { SupabaseClient } from "@supabase/supabase-js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function byoWelcomeEmailHtml(legalName: string, dashboardUrl: string, helpUrl: string): string {
  const safeUrl = /^https:\/\/[a-z0-9.-]+/.test(dashboardUrl) ? dashboardUrl : "#";
  const safeHelp = /^https:\/\/[a-z0-9.-]+/.test(helpUrl) ? helpUrl : "#";
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f6f6f6;font-family:Arial,sans-serif;"><tbody><tr><td align="center" style="padding:24px 0;">
  <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;"><tbody>
    <tr><td style="padding:24px;background-color:#1f2937;">
      <h1 style="margin:0;color:#ffffff;font-size:20px;">AI Travel Concierge</h1>
    </td></tr>
    <tr><td style="padding:24px 32px;line-height:1.6;font-size:15px;color:#222222;">
      <h2 style="margin:0 0 16px 0;color:#1f2937;font-size:22px;">Your agency is live — welcome aboard!</h2>
      <p>Thank you for choosing AI Travel Concierge. <strong>${esc(legalName)}</strong> is now active and your AI concierge is ready to greet customers.</p>
      <p style="margin:20px 0 8px 0;font-weight:700;color:#1f2937;">Here's what you get out of the box:</p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tbody>
        <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;vertical-align:top;width:28px;font-size:18px;">&#9992;&#65039;</td>
            <td style="padding:10px 0 10px 12px;border-bottom:1px solid #f0f0f0;"><strong>24/7 AI concierge, branded as yours</strong><br>
            <span style="color:#555555;">Handles routine customer questions about itineraries, ports, cabins, and pricing around the clock so you can focus on the relationships that need a human touch.</span></td></tr>
        <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;vertical-align:top;font-size:18px;">&#128172;</td>
            <td style="padding:10px 0 10px 12px;border-bottom:1px solid #f0f0f0;"><strong>Quotes and booking pipeline</strong><br>
            <span style="color:#555555;">The AI builds quotes and shares them with customers in chat. When they're ready to book, it captures their intent and hands off to you — no separate quoting tool needed.</span></td></tr>
        <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;vertical-align:top;font-size:18px;">&#128140;</td>
            <td style="padding:10px 0 10px 12px;border-bottom:1px solid #f0f0f0;"><strong>Pre-cruise email automation</strong><br>
            <span style="color:#555555;">T-90, T-30, T-7, and T-1 emails go out to booked customers automatically, personalized to your brand voice. Set it up once; it runs itself.</span></td></tr>
        <tr><td style="padding:10px 0;vertical-align:top;font-size:18px;">&#128203;</td>
            <td style="padding:10px 0 10px 12px;"><strong>CRM with full conversation history</strong><br>
            <span style="color:#555555;">Every customer conversation is logged in your CRM. In Draft Only mode you review and approve AI responses before they're sent — full control while you build trust.</span></td></tr>
      </tbody></table>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:28px 0;"><tbody><tr><td align="center">
        <table role="presentation" cellspacing="0" cellpadding="0"><tbody><tr>
          <td style="border-radius:8px;background-color:#3b82f6;">
            <a href="${safeUrl}" style="display:inline-block;padding:14px 32px;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;">Go to your dashboard &#8594;</a>
          </td>
        </tr></tbody></table>
      </td></tr></tbody></table>
      <p style="font-size:13px;color:#888888;">Questions? Browse our <a href="${safeHelp}" style="color:#3b82f6;">help docs</a> or ask the chat bubble on any admin page.</p>
    </td></tr>
    <tr><td style="padding:16px 32px;background-color:#fafafa;border-top:1px solid #eeeeee;font-size:12px;color:#888888;">
      <p style="margin:0;">AI Travel Concierge &#8212; the team</p>
    </td></tr>
  </tbody></table>
</td></tr></tbody></table>`;
}

// Best-effort welcome notification. Failure must NOT block or roll back activation.
async function sendBYOWelcomeEmail(db: SupabaseClient, tenantId: string): Promise<void> {
  const appUrl = process.env.PLATFORM_APP_URL ?? "https://app.ai-travelconcierge.com";
  const primaryDomain = process.env.PLATFORM_PRIMARY_DOMAIN ?? "ai-travelconcierge.com";

  const [tenantRes, usersRes] = await Promise.all([
    db.from("tenants").select("legal_name, slug").eq("id", tenantId).single(),
    db.from("users").select("email").eq("tenant_id", tenantId).eq("status", "active"),
  ]);

  if (tenantRes.error || !tenantRes.data) return;
  const { legal_name, slug } = tenantRes.data as { legal_name: string | null; slug: string | null };

  const recipients = ((usersRes.data ?? []) as Array<{ email: string }>).map((u) => u.email);
  if (recipients.length === 0) return;

  const dashboardUrl =
    slug && /^[a-z0-9-]+$/.test(slug)
      ? `https://${slug}.${primaryDomain}/`
      : `${appUrl}/crm/contacts`;
  const helpUrl = `${appUrl}/help`;
  const html = byoWelcomeEmailHtml(legal_name ?? "Your agency", dashboardUrl, helpUrl);

  const { sendTenantNotification } = await import("@/lib/email/notifications");
  for (const to of recipients) {
    await sendTenantNotification({
      db,
      tenant_id: tenantId,
      to,
      subject: "Welcome to AI Travel Concierge — your agency is live",
      html,
      category: "transactional",
      template_id: "byo_host_welcome",
      template_variables: { legal_name: legal_name ?? "", dashboard_url: dashboardUrl, help_url: helpUrl },
    });
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "onboarding", action: "branding:skip" });

    const db = tenantClient(ctx);
    const { data: tenant, error } = await db
      .from("tenants")
      .select("tenant_type, onboarding_stage")
      .eq("id", ctx.tenant_id)
      .single();

    if (error) return dbErrorResponse(error);

    if (tenant?.tenant_type === "byo_host") {
      // Self-activation — no admin approval. `branding` is the ONLY legitimate
      // source stage: a BYO host reaches it via subscription→branding (§15.8
      // success_url) only AFTER Stripe checkout, so requiring it here is what
      // stops a direct POST from an earlier stage (signup/subscription/…) from
      // activating a tenant that never paid. The sub-host branch gets this
      // forward-transition guard for free from progressTo; the BYO branch must
      // enforce it explicitly (D-091: validate transitions at the boundary,
      // don't trust the caller's stage).
      if (tenant.onboarding_stage === "complete") {
        // Already activated (post-success double-click): idempotent no-op —
        // don't re-stamp activated_at or 500 a legitimate retry. Mirrors
        // progressTo's isAtOrPast short-circuit.
        return Response.json({ ok: true, next_stage: "complete" });
      }
      if (tenant.onboarding_stage !== "branding") {
        return Response.json({ error: "invalid_onboarding_stage" }, { status: 409 });
      }
      // CAS-guarded on `branding` so a concurrent writer / double-click that
      // already advanced the stage yields a zero-row mismatch (→ throw), not a
      // silent second activation. The tenant boundary is the explicit
      // `.eq("id", ctx.tenant_id)` — `tenants`' PK *is* the tenant id and
      // tenantClient passes it through, so this is the DB-layer constraint
      // D-091 requires; `.eq("onboarding_stage", "branding")` is the CAS guard.
      await safeAwaitRowCount(
        db
          .from("tenants")
          .update({
            status: "active",
            activated_at: new Date().toISOString(),
            onboarding_stage: "complete",
          })
          .eq("id", ctx.tenant_id)
          .eq("onboarding_stage", "branding")
          .select("id"),
        "tenants.update.byo_activate_on_branding_skip",
        1,
      );
      // Best-effort — failure must not block the activation response.
      sendBYOWelcomeEmail(db, ctx.tenant_id).catch((err) => {
        console.warn("[branding-skip] welcome email failed: %s", err instanceof Error ? err.message : String(err));
      });
      return Response.json({ ok: true, next_stage: "complete" });
    }

    await progressTo(ctx.tenant_id, "review_submitted");
    return Response.json({ ok: true, next_stage: "review_submitted" });
  } catch (err) {
    return respondToAuthError(err);
  }
}
