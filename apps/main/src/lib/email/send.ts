// audit-2026-05-26: Greptile review checkpoint (will be reverted; do not merge)
// §23.1 / §23.6 / §23.7 — Unified email send helper.
//
// Flow:
//   1. Check email_suppressions for (tenant_id, to_email, reason).
//   2. Check rate limit per §23.6.
//   3. Resolve from-address per tenant email_send_pattern (Pattern A / B).
//   4. Call Resend API with the caller-provided HTML string.
//   5. Write email_log row.
//
// Rendering React email templates to HTML is the caller's responsibility.
// Callers must use a dynamic import for react-dom/server to avoid bundler
// issues with Next.js App Router API routes:
//   const { renderToStaticMarkup } = await import("react-dom/server");
//   const html = renderToStaticMarkup(jsx);
//
// Callers must pass a service-role SupabaseClient (db) — this function writes
// email_log and reads suppressions at the service level.

import type { SupabaseClient } from "@supabase/supabase-js";
import { checkRateLimit, type EmailCategory } from "./rate-limit";
import { decryptCredential } from "@/lib/crypto/credential-cipher";
import { recordVendorFailure, recordVendorSuccess } from "@/lib/vendor-health/registry";
import { loadTenantSnapshot } from "@/lib/abuse/snapshot";
import { incrementEmailSent } from "@/lib/abuse/counters";

export interface SendEmailInput {
  db: SupabaseClient;
  tenant: {
    id: string;
    legal_name: string;
    mailing_address?: string | null;
    email_send_pattern: "platform_resend" | "tenant_resend";
    tenant_resend_api_key_encrypted?: string | null;
    email_from_address?: string | null;
    email_from_name?: string | null;
  };
  to: string;
  subject: string;
  template_id: string;
  template_variables?: Record<string, unknown>;
  category: EmailCategory;
  // Pre-rendered HTML — caller must render the JSX template before calling sendEmail.
  html: string;
  related_booking_id?: string;
  related_group_id?: string;
  user_id?: string;
  contact_id?: string;
  reply_to?: string;
}

export interface EmailSendResult {
  status: "sent" | "suppressed" | "rate_limited" | "failed";
  reason?: string | null;
  email_log_id?: string | null;
  resend_message_id?: string | null;
}

const RESEND_API_URL = "https://api.resend.com/emails";

export async function sendEmail(input: SendEmailInput): Promise<EmailSendResult> {
  const { db, tenant, to, subject, template_id, category, html } = input;

  // §25.10 — Staging outbound isolation. When STAGING_MODE=true and
  // TEST_OVERRIDE_EMAIL is set, redirect ALL outbound email to the test
  // address so a restored prod copy doesn't accidentally email real users.
  // The override happens before suppression checks so we don't accidentally
  // skip-suppress test-mode sends.
  const stagingOverrideTo =
    process.env.STAGING_MODE === "true" ? process.env.TEST_OVERRIDE_EMAIL : null;
  const effectiveTo = stagingOverrideTo ?? to;

  // 1 — Suppression check
  const suppressionReasons: string[] = ["unsubscribe_all", "hard_bounce", "complaint"];
  if (category === "marketing") suppressionReasons.push("unsubscribe_marketing");
  if (category === "travel_news") suppressionReasons.push("unsubscribe_travel_news");

  const { data: suppressions } = await db
    .from("email_suppressions")
    .select("reason")
    .eq("tenant_id", tenant.id)
    .eq("email_address", to)
    .in("reason", suppressionReasons)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);

  if (suppressions && suppressions.length > 0) {
    const firstSuppression = suppressions[0] as { reason: string } | undefined;
    return { status: "suppressed", reason: firstSuppression?.reason ?? null };
  }

  // 2 — Rate limit check
  const rl = await checkRateLimit({ db, tenant_id: tenant.id, to_email: to, category });
  if (!rl.allowed) {
    return { status: "rate_limited", reason: rl.reason ?? null };
  }

  // 3 — Resolve from-address
  let apiKey: string;
  const fromName = tenant.email_from_name ?? tenant.legal_name ?? "AI Travel Concierge";
  const fromAddr = tenant.email_from_address ?? "noreply@ai-travelconcierge.com";
  const from = `${fromName} <${fromAddr}>`;

  if (tenant.email_send_pattern === "tenant_resend") {
    if (!tenant.tenant_resend_api_key_encrypted) {
      return { status: "failed", reason: "tenant_resend_api_key_not_set" };
    }
    let parsed: { ciphertext: string; key_id: string };
    try {
      parsed = JSON.parse(tenant.tenant_resend_api_key_encrypted) as { ciphertext: string; key_id: string };
    } catch {
      return { status: "failed", reason: "encrypted_key_malformed" };
    }
    const decrypted = decryptCredential(parsed);
    if (!decrypted.ok) {
      return { status: "failed", reason: `decrypt_failed: ${decrypted.error.code}` };
    }
    apiKey = decrypted.value;
  } else {
    const platformKey = process.env.RESEND_API_KEY;
    if (!platformKey) return { status: "failed", reason: "platform_resend_key_not_set" };
    apiKey = platformKey;
  }

  // 4 — Call Resend
  let resendMessageId: string | undefined;
  let sendStatus: "sent" | "failed" = "sent";
  let sendFailReason: string | undefined;

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: effectiveTo,
        subject: stagingOverrideTo ? `[STAGING → ${to}] ${subject}` : subject,
        html,
        ...(input.reply_to ? { reply_to: input.reply_to } : {}),
      }),
    });

    if (!res.ok) {
      sendStatus = "failed";
      sendFailReason = `resend_${res.status}`;
      // BP26 §26.9 vendor-health: any non-2xx counts as a failure so the
      // probe + circuit breaker have signal.
      recordVendorFailure("resend", `${res.status}`);
    } else {
      const body = await res.json() as { id?: string };
      resendMessageId = body.id;
      recordVendorSuccess("resend");
    }
  } catch (err) {
    sendStatus = "failed";
    sendFailReason = `resend_throw: ${String(err)}`;
    recordVendorFailure("resend", err instanceof Error ? err.message : String(err));
  }

  // 6 — Write email_log row
  const logRow: Record<string, unknown> = {
    tenant_id: tenant.id,
    to_email: to,
    from_email: fromAddr,
    subject,
    template_id,
    template_variables: input.template_variables ?? null,
    email_category: category,
    status: sendStatus === "sent" ? "sent" : "rejected",
    sent_at: sendStatus === "sent" ? new Date().toISOString() : null,
    resend_message_id: resendMessageId ?? null,
    ...(input.user_id ? { user_id: input.user_id } : {}),
    ...(input.contact_id ? { contact_id: input.contact_id } : {}),
    ...(input.reply_to ? { reply_to: input.reply_to } : {}),
    ...(input.related_booking_id ? { related_booking_id: input.related_booking_id } : {}),
    ...(input.related_group_id ? { related_group_id: input.related_group_id } : {}),
  };

  const { data: logRow_ } = await db.from("email_log").insert(logRow).select("id").single();
  const emailLogId = (logRow_ as { id?: string } | null)?.id;

  if (sendStatus === "failed") {
    return { status: "failed", reason: sendFailReason ?? null, email_log_id: emailLogId ?? null };
  }

  // BP27 §27.4 — bump the email-sent counter so the daily soft1/soft2/hard
  // limits + state-machine transitions fire. Non-fatal: if the counter
  // increment or snapshot load fails, the send still succeeds (an email
  // already delivered to Resend MUST NOT be reported as failed).
  try {
    const snapshot = await loadTenantSnapshot(db, tenant.id);
    await incrementEmailSent({ db, tenant: snapshot.tenant });
  } catch (err) {
    console.warn(`[email/send] counter increment failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  return { status: "sent", email_log_id: emailLogId ?? null, resend_message_id: resendMessageId ?? null };
}
