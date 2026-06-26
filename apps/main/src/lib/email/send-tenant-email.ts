// §16.4 — Tenant email sender with Pattern A (tenant's Resend) / Pattern B
// (platform Resend) selection. Reads tenant_branding to pick the right
// API key + from address.
//
// Pattern A: decrypt tenant_resend_api_key_encrypted (uses APP_ENCRYPTION_KEY_*
// framework from BP14) and send through the tenant's Resend account.
// Pattern B (default): platform RESEND_API_KEY with tenant's email_from values.

import { decryptCredential } from "@/lib/crypto/credential-cipher";

export interface TenantBrandingForEmail {
  email_send_pattern: "platform_resend" | "tenant_resend";
  tenant_resend_api_key_encrypted?: string | null;
  email_from_address?: string | null;
  email_from_name?: string | null;
}

export interface SendEmailOpts {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface SendEmailResult {
  ok: boolean;
  pattern: "platform_resend" | "tenant_resend";
  resend_id?: string;
  error?: string;
}

const RESEND_API_URL = "https://api.resend.com/emails";

async function sendViaResend(apiKey: string, from: string, opts: SendEmailOpts): Promise<SendEmailResult> {
  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      ...(opts.text ? { text: opts.text } : {}),
    }),
  });

  if (!res.ok) {
    return { ok: false, pattern: "platform_resend", error: `Resend ${res.status}: ${await res.text()}` };
  }

  const body = await res.json() as { id?: string };
  return { ok: true, pattern: "platform_resend", ...(body.id ? { resend_id: body.id } : {}) };
}

export async function sendTenantEmail(
  branding: TenantBrandingForEmail,
  opts: SendEmailOpts,
): Promise<SendEmailResult> {
  const fromName = branding.email_from_name ?? "AI Travel Concierge";
  const fromAddr = branding.email_from_address ?? "noreply@email.ai-travelconcierge.com";
  const from = `${fromName} <${fromAddr}>`;

  if (branding.email_send_pattern === "tenant_resend") {
    if (!branding.tenant_resend_api_key_encrypted) {
      return { ok: false, pattern: "tenant_resend", error: "tenant_resend_api_key_not_set" };
    }
    // The encrypted column stores JSON: { ciphertext, key_id } per §13.5.1.
    let payload: { ciphertext: string; key_id: string };
    try {
      payload = JSON.parse(branding.tenant_resend_api_key_encrypted) as { ciphertext: string; key_id: string };
    } catch {
      return { ok: false, pattern: "tenant_resend", error: "encrypted_key_malformed" };
    }
    const decrypted = decryptCredential(payload);
    if (!decrypted.ok) {
      return { ok: false, pattern: "tenant_resend", error: `decrypt_failed: ${decrypted.error.code}` };
    }
    const result = await sendViaResend(decrypted.value, from, opts);
    return { ...result, pattern: "tenant_resend" };
  }

  // Pattern B (default) — platform Resend.
  const platformKey = process.env.RESEND_API_KEY;
  if (!platformKey) {
    return { ok: false, pattern: "platform_resend", error: "platform_resend_key_not_set" };
  }
  return sendViaResend(platformKey, from, opts);
}
