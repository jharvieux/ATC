-- §16.4 — Wire email_from_domain verification via Resend.
--
-- Pre-fix: tenant_branding.email_from_domain was captured by the UI and
-- stored, but never used. email_from_domain_verified_at column existed
-- but was never written. The "Custom email-from domain" Agency-tier
-- feature was a no-op.
--
-- This migration adds the two columns the verification flow needs:
--   - resend_domain_id: the UUID Resend assigns when we register the
--     domain via POST /v1/domains. Stored so subsequent verify-status
--     polls can reach the right domain object.
--   - email_from_domain_dns_records: the DNS records (SPF, DKIM, MX)
--     Resend returned at creation time. Surfaced to the UI so the
--     tenant operator can copy them into their DNS provider.

ALTER TABLE public.tenant_branding
  ADD COLUMN IF NOT EXISTS resend_domain_id TEXT,
  ADD COLUMN IF NOT EXISTS email_from_domain_dns_records JSONB;
