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

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkRateLimit, type EmailCategory } from "./rate-limit";
import { decryptCredential } from "@/lib/crypto/credential-cipher";
import { recordVendorFailure, recordVendorSuccess } from "@/lib/vendor-health/registry";
import { loadTenantSnapshot } from "@/lib/abuse/snapshot";
import { incrementEmailSent } from "@/lib/abuse/counters";

// #1935 — shared tenant_branding column projection for every cron/job that
// reads branding before sending mail. Two crons omitted email_from_domain /
// email_from_domain_verified_at, so a tenant with a verified custom domain
// got a different from-address depending on which cron sent — importing
// this constant instead of hand-writing the column list is what keeps them
// from drifting apart again.
export const TENANT_BRANDING_COLUMNS =
  "tenant_id, logo_url, primary_color, secondary_color, accent_color, slogan, " +
  "email_send_pattern, tenant_resend_api_key_encrypted, email_from_address, " +
  "email_from_name, email_from_domain, email_from_domain_verified_at";

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
    // §16.4 — when a tenant has verified their own from-domain via the
    // /api/tenant/branding/email-domain/verify endpoint, prefer it for the
    // from address. email_from_domain_verified_at acts as the gate; until
    // verification succeeds the field is null and we fall back to the
    // platform default below. Both fields are optional — callers that
    // don't fetch them get the default behavior.
    email_from_domain?: string | null;
    email_from_domain_verified_at?: string | null;
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
  // §23/#1580 — deterministic dedup key forwarded to Resend as the
  // Idempotency-Key header. Resend dedupes retries of the same key within
  // its retention window, so an Inngest step retry or a network-timeout
  // retry that already delivered the first attempt won't double-send.
  // Callers should pass something stable across retries of the same logical
  // send, e.g. `pre_cruise:${booking_id}:${phase}` — NOT a fresh UUID per
  // call, which would defeat the dedup. Optional: sends without one behave
  // exactly as before (no header sent).
  idempotencyKey?: string;
  // §23.7/#1611 — set to the ORIGINAL email_log id when this send is itself a
  // soft-bounce re-send. Two effects: the row is stamped email_log.retry_of so
  // the Resend webhook won't start a fresh retry chain for it, and sendEmail
  // does NOT persist a new email_retry_content row (the original send owns the
  // stored payload; re-sends must not spawn their own retry chains). Absent for
  // normal sends.
  retry_of?: string;
}

// §23.7/#1611 — how long a stored rendered-HTML payload lives before the purge
// cron deletes it. Must exceed Resend's soft-bounce-arrival window plus the full
// +6h/+12h/+24h retry chain (+ terminal grace) so content is never purged out
// from under an in-flight retry. 7 days is a comfortable margin; rendered emails
// are PII, so this is deliberately short.
const RETRY_CONTENT_TTL_DAYS = 7;

export interface EmailSendResult {
  status: "sent" | "suppressed" | "rate_limited" | "failed";
  reason?: string | null;
  email_log_id?: string | null;
  resend_message_id?: string | null;
}

const RESEND_API_URL = "https://api.resend.com/emails";

// Verified Resend sending domain is the `email.` subdomain (the apex is not
// verified). All platform-default senders use it.
const PLATFORM_DEFAULT_FROM = "noreply@email.ai-travelconcierge.com";

/**
 * §16.4 from-address resolver. Precedence:
 *   1. If a verified email_from_domain exists AND email_from_address looks
 *      like a local-part-only string (no @), combine them: "support@acme.com".
 *   2. If email_from_address is a full address (contains @), use it as-is.
 *      (Legacy behavior — predates the verified-domain feature; the operator
 *      already typed a full address, so honor it.)
 *   3. If a verified email_from_domain exists but no email_from_address,
 *      use "noreply@<verified-domain>".
 *   4. Fall back to the platform default "noreply@email.ai-travelconcierge.com".
 *
 * "Verified" means email_from_domain_verified_at is non-null. An unverified
 * domain (set in the UI but DNS not yet confirmed) is ignored to prevent
 * sending under a domain we haven't proven we own — Resend would reject the
 * send and the customer would see a bounce.
 */
export function resolveFromAddress(args: {
  email_from_address: string | null;
  email_from_domain: string | null;
  email_from_domain_verified_at: string | null;
}): string {
  const verifiedDomain = args.email_from_domain_verified_at ? args.email_from_domain : null;
  const addr = args.email_from_address?.trim() ?? null;

  if (addr && addr.includes("@")) return addr; // legacy full-address override
  if (verifiedDomain && addr) return `${addr}@${verifiedDomain}`;
  if (verifiedDomain) return `noreply@${verifiedDomain}`;
  if (addr) return addr; // operator typed something but no domain — best effort
  return PLATFORM_DEFAULT_FROM;
}

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
  // Coalesce empty/whitespace too, not just null: a blank email_from_name
  // (tenant_branding stores "" rather than NULL) must fall through to
  // legal_name, else the from header becomes " <addr>" and Resend rejects it
  // with a 422 "Invalid `from` field" — a silent, fail-soft delivery failure.
  const fromName = tenant.email_from_name?.trim() || tenant.legal_name?.trim() || "AI Travel Concierge";
  const fromAddr = resolveFromAddress({
    email_from_address: tenant.email_from_address ?? null,
    email_from_domain: tenant.email_from_domain ?? null,
    email_from_domain_verified_at: tenant.email_from_domain_verified_at ?? null,
  });
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
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
      },
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
    ...(input.retry_of ? { retry_of: input.retry_of } : {}),
    ...(input.user_id ? { user_id: input.user_id } : {}),
    ...(input.contact_id ? { contact_id: input.contact_id } : {}),
    ...(input.reply_to ? { reply_to: input.reply_to } : {}),
    ...(input.related_booking_id ? { related_booking_id: input.related_booking_id } : {}),
    ...(input.related_group_id ? { related_group_id: input.related_group_id } : {}),
  };

  // Non-fatal: the email was already handed to the vendor above, so a failed
  // audit-log insert must NOT flip a delivered email to "failed". Surface the
  // discarded error as a warning (D-091, #400) — the row is missing, not the
  // send.
  const { data: logRow_, error: logErr } = await db.from("email_log").insert(logRow).select("id").single();
  if (logErr) console.warn(`[email/send] email_log insert failed (non-fatal): ${logErr.message}`);
  const emailLogId = (logRow_ as { id?: string } | null)?.id;

  if (sendStatus === "failed") {
    return { status: "failed", reason: sendFailReason ?? null, email_log_id: emailLogId ?? null };
  }

  // §23.7/#1611 — persist the rendered payload so a soft bounce can re-send it
  // verbatim (option (a)). Only for ORIGINAL sends (not re-sends — the original
  // owns the retry chain) and only once we have an email_log id to key on.
  // Written AFTER dispatch (D-091 #10) and non-fatal: the email is already with
  // the vendor, so a failed content insert must NOT flip a delivered send to
  // failed — it only means this particular send can't be retried on a bounce.
  if (!input.retry_of && emailLogId) {
    try {
      const expiresAt = new Date(Date.now() + RETRY_CONTENT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { error: retryErr } = await db.from("email_retry_content").insert({
        email_log_id: emailLogId,
        tenant_id: tenant.id,
        to_email: to,
        subject,
        template_id,
        email_category: category,
        html,
        expires_at: expiresAt,
        ...(input.reply_to ? { reply_to: input.reply_to } : {}),
        ...(input.related_booking_id ? { related_booking_id: input.related_booking_id } : {}),
        ...(input.related_group_id ? { related_group_id: input.related_group_id } : {}),
        ...(input.user_id ? { user_id: input.user_id } : {}),
        ...(input.contact_id ? { contact_id: input.contact_id } : {}),
      });
      if (retryErr) console.warn(`[email/send] email_retry_content insert failed (non-fatal): ${retryErr.message}`);
    } catch (err) {
      console.warn(`[email/send] email_retry_content insert threw (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
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
