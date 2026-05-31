// #489 — Platform tenant shim for admin-initiated sends.
//
// When platform admins send sample emails from /admin/email-samples, the
// send uses this shim as the "tenant" so email_log rows are keyed under
// the platform sentinel UUID (queryable separately from real tenant mail).
// The shim always falls back to the platform default from-address because
// email_from_domain_verified_at is null.

import { PLATFORM_SENTINEL_TENANT_ID } from "@/lib/rag-auth/platform-sentinel";

export const PLATFORM_TENANT_SHIM = {
  id: PLATFORM_SENTINEL_TENANT_ID,
  legal_name: "AI Travel Concierge",
  mailing_address: "123 Platform Way, Suite 1, San Francisco, CA 94103",
  email_send_pattern: "platform_resend" as const,
  tenant_resend_api_key_encrypted: null,
  email_from_address: null,
  email_from_name: "AI Travel Concierge",
  email_from_domain: null,
  email_from_domain_verified_at: null,
};

export const PLATFORM_BRANDING = {
  primary_color: "#0F172A",
  accent_color: "#3B82F6",
  slogan: "AI Travel Concierge — Concierge-grade trip planning",
  logo_url: (process.env.PLATFORM_LOGO_URL ?? null) as string | null,
};
