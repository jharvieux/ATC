// §23 — Notification email helpers for operational sites.
// Consolidates work previously tracked under placeholder markers prior to 2026-05-25.
//
// Two flavors:
//
//   sendTenantNotification — loads the tenant's branding row and routes
//     through the existing sendEmail() pipeline (suppressions + rate
//     limit + email_log). Use for tenant-facing notifications like
//     termination notice, legal doc publish, custom domain drift, etc.
//
//   sendOperatorNotification — sends to the platform operator
//     (PLATFORM_OPERATOR_EMAIL env var) via the platform Resend key,
//     bypassing tenant lookup. Use for crown-jewel audit reminders and
//     other platform-internal alerts that don't have a tenant context.
//
// Templates: callers pass plain HTML + text. These are operational, not
// marketing — keep them simple, no React-email rendering required.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail, type EmailSendResult } from "./send";
import type { EmailCategory } from "./rate-limit";

interface TenantBrandingRow {
  legal_name: string;
  mailing_address: string | null;
  email_send_pattern: string;
  tenant_resend_api_key_encrypted: string | null;
  email_from_address: string | null;
  email_from_name: string | null;
}

interface SendTenantNotificationInput {
  db: SupabaseClient;
  tenant_id: string;
  to: string;
  subject: string;
  html: string;
  category: EmailCategory;
  template_id: string;
  template_variables?: Record<string, unknown>;
  user_id?: string;
  contact_id?: string;
  reply_to?: string;
  idempotencyKey?: string;
}

/**
 * Tenant-facing notification. Loads tenant_branding for the from-address
 * pattern, then sends via the full sendEmail() pipeline (suppressions +
 * rate limit + email_log).
 */
export async function sendTenantNotification(
  input: SendTenantNotificationInput,
): Promise<EmailSendResult> {
  const { db, tenant_id } = input;

  // Load minimal tenant info for from-address resolution.
  const { data: tenantRow } = await db
    .from("tenants")
    .select("id, legal_name, mailing_address")
    .eq("id", tenant_id)
    .maybeSingle();
  const { data: brandingRow } = await db
    .from("tenant_branding")
    .select(
      "email_send_pattern, tenant_resend_api_key_encrypted, email_from_address, email_from_name",
    )
    .eq("tenant_id", tenant_id)
    .maybeSingle();

  const tenant = tenantRow as { id: string; legal_name: string; mailing_address: string | null } | null;
  if (!tenant) {
    return { status: "failed", reason: "tenant_not_found" };
  }
  const branding = (brandingRow ?? null) as TenantBrandingRow | null;

  return sendEmail({
    db,
    tenant: {
      id: tenant.id,
      legal_name: tenant.legal_name,
      mailing_address: tenant.mailing_address,
      email_send_pattern: (branding?.email_send_pattern as "platform_resend" | "tenant_resend") ?? "platform_resend",
      tenant_resend_api_key_encrypted: branding?.tenant_resend_api_key_encrypted ?? null,
      email_from_address: branding?.email_from_address ?? null,
      email_from_name: branding?.email_from_name ?? null,
    },
    to: input.to,
    subject: input.subject,
    template_id: input.template_id,
    template_variables: input.template_variables ?? {},
    category: input.category,
    html: input.html,
    ...(input.user_id ? { user_id: input.user_id } : {}),
    ...(input.contact_id ? { contact_id: input.contact_id } : {}),
    ...(input.reply_to ? { reply_to: input.reply_to } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });
}

interface SendOperatorNotificationInput {
  subject: string;
  html: string;
  text?: string;
}

interface OperatorNotificationResult {
  status: "sent" | "skipped_no_operator_email" | "failed";
  resend_id?: string;
  error?: string;
}

/**
 * Platform-operator notification. Sends to PLATFORM_OPERATOR_EMAIL via the
 * platform Resend key. Bypasses tenant lookup, suppressions, and rate-limit
 * checks — these are alerts to a small fixed audience.
 *
 * If PLATFORM_OPERATOR_EMAIL is unset, returns "skipped_no_operator_email"
 * so the caller can log a warning without crashing. Same posture if
 * RESEND_API_KEY is unset.
 */
export async function sendOperatorNotification(
  input: SendOperatorNotificationInput,
): Promise<OperatorNotificationResult> {
  const to = process.env.PLATFORM_OPERATOR_EMAIL;
  if (!to) return { status: "skipped_no_operator_email" };
  return sendDirectViaResend({ to, ...input });
}

interface SendPlatformUserEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Platform-level user notification (not tenant-scoped). Used for things
 * like CCPA exports where the user can span multiple tenants, so there's
 * no single tenant_branding row to load. Sends via platform Resend with
 * the platform-default from-address. Bypasses suppressions + rate limit.
 */
export async function sendPlatformUserEmail(
  input: SendPlatformUserEmailInput,
): Promise<OperatorNotificationResult> {
  return sendDirectViaResend(input);
}

async function sendDirectViaResend(
  input: { to: string; subject: string; html: string; text?: string },
): Promise<OperatorNotificationResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { status: "skipped_no_operator_email" };

  const from =
    process.env.PLATFORM_OPERATOR_FROM_EMAIL ??
    "AI Travel Concierge <noreply@email.ai-travelconcierge.com>";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        ...(input.text ? { text: input.text } : {}),
      }),
    });
    if (!res.ok) {
      return { status: "failed", error: `resend_${res.status}` };
    }
    const body = (await res.json()) as { id?: string };
    return {
      status: "sent",
      ...(body.id ? { resend_id: body.id } : {}),
    };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
