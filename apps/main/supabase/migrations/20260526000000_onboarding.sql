-- §15.1–15.15 — Tenant onboarding additions.
--
-- The tenants table in 20260521120000_tenancy_and_identity.sql already contains:
--   slug, display_name, legal_name, tenant_type, status, seat_count, billing_period,
--   stripe_*, support_email, support_phone, mailing_address, timezone, ai_mode,
--   is_sandbox, onboarding_stage (TEXT without CHECK), w9_received_at, ica_accepted_at,
--   activated_at, suspended_at/reason, terminated_at/reason.
--
-- This migration adds what's missing for the full §15 flow.

-- ── onboarding_stage CHECK constraint ────────────────────────────────────────
-- The column exists but has no CHECK. Add it now.
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_onboarding_stage_check
    CHECK (onboarding_stage IS NULL OR onboarding_stage IN (
      'signup','profile','legal','ica','tax_form',
      'state_of_operation','tier_select','subscription',
      'connect_setup','branding','review_submitted','complete'
    ));

-- ── sandbox_mode / is_sandbox ────────────────────────────────────────────────
-- Spec names the column sandbox_mode; existing schema uses is_sandbox. They are the
-- same concept. No column addition needed; is_sandbox already exists.
-- MEMORY: The column in tenants is named is_sandbox (NOT sandbox_mode). All code must
-- use is_sandbox.

-- ── New columns on tenants ────────────────────────────────────────────────────

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS state_of_operation TEXT,  -- US state code (2-char)
  ADD COLUMN IF NOT EXISTS review_decision TEXT
    CHECK (review_decision IS NULL OR review_decision IN (
      'pending','approved','rejected','more_info_requested'
    )),
  ADD COLUMN IF NOT EXISTS review_decision_reason TEXT,
  ADD COLUMN IF NOT EXISTS review_decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_decided_by_user_id UUID REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS requires_ica_reacceptance BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS connect_setup_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_billing_period_change_effective_at TIMESTAMPTZ;

-- ── conversations: sandbox flag ──────────────────────────────────────────────
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT FALSE;

-- ── bookings: sandbox flag ───────────────────────────────────────────────────
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT FALSE;

-- ── tenant_inactivity_nudges — §15.13 ────────────────────────────────────────
CREATE TABLE public.tenant_inactivity_nudges (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES public.tenants(id),
  nudge_level TEXT        NOT NULL CHECK (nudge_level IN ('30d','60d','90d','180d')),
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, nudge_level)  -- one nudge per level per tenant (re-insert on reset)
);

CREATE INDEX tenant_inactivity_nudges_tenant_idx ON public.tenant_inactivity_nudges(tenant_id);

ALTER TABLE public.tenant_inactivity_nudges ENABLE ROW LEVEL SECURITY;

-- Tenants can see their own nudge history; service_role writes.
CREATE POLICY tenant_inactivity_nudges_select ON public.tenant_inactivity_nudges
  FOR SELECT USING (auth_user_in_tenant(tenant_id));
CREATE POLICY tenant_inactivity_nudges_insert ON public.tenant_inactivity_nudges
  FOR INSERT WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY tenant_inactivity_nudges_update ON public.tenant_inactivity_nudges
  FOR UPDATE USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY tenant_inactivity_nudges_delete ON public.tenant_inactivity_nudges
  FOR DELETE USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_inactivity_nudges TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_inactivity_nudges TO service_role;

-- ── platform_settings: host agency legal name ────────────────────────────────
-- Seed with a TODO(operator) placeholder per §15.7.
INSERT INTO public.platform_settings (key, value)
VALUES ('host_agency_legal_name', '"[HOST AGENCY LEGAL NAME — TODO(operator): replace before Phase 2 launch]"')
ON CONFLICT (key) DO NOTHING;
