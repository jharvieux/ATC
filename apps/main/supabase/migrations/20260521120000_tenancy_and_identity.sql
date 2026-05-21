-- Migration: tenancy and identity
-- Spec refs: §5.1 (tenants, users), §5.1.X (hard-delete protection)
--
-- This migration establishes the two foundational tables (tenants, users)
-- and the hard-delete protection trigger for tenants. RLS is enabled in a
-- later migration (0003) once the helper functions exist.

-- ---------------------------------------------------------------------------
-- tier_definitions stub
--
-- The spec §5.3 calls out "full DDL in repository" but does not give the DDL.
-- This is a placeholder seeded with the six tier codes from §3.3. Expand when
-- the full tier-pricing logic lands (spec Section 14).
-- ---------------------------------------------------------------------------

CREATE TABLE public.tier_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.tier_definitions IS
  'Stub. Seeded with six tier codes from spec §3.3. Expand with full pricing/feature columns when Section 14 is implemented.';

INSERT INTO public.tier_definitions (code, display_name) VALUES
  ('byo_research',     'BYO Research'),
  ('byo_professional', 'BYO Professional'),
  ('byo_agency',       'BYO Agency'),
  ('sub_starter',      'Sub-Host Starter'),
  ('sub_pro',          'Sub-Host Pro'),
  ('sub_agency',       'Sub-Host Agency');

-- ---------------------------------------------------------------------------
-- tenants — per spec §5.1
-- ---------------------------------------------------------------------------

CREATE TABLE public.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  slug TEXT UNIQUE NOT NULL CHECK (slug = LOWER(slug) AND
    slug ~ '^[a-z0-9-]{1,28}[a-z0-9]$'),

  display_name TEXT NOT NULL,
  legal_name   TEXT NOT NULL,

  tenant_type TEXT NOT NULL
    CHECK (tenant_type IN ('platform','byo_host','sub_host')),

  status TEXT NOT NULL DEFAULT 'onboarding'
    CHECK (status IN ('onboarding','pending_review','active','suspended','terminated')),

  -- Tier and billing
  tier_id UUID REFERENCES public.tier_definitions(id),

  seat_count     INTEGER NOT NULL DEFAULT 1 CHECK (seat_count >= 1),
  billing_period TEXT NOT NULL DEFAULT 'monthly'
    CHECK (billing_period IN ('monthly','annual')),

  stripe_customer_id        TEXT,
  stripe_subscription_id    TEXT,
  stripe_connect_account_id TEXT,

  -- Contact info
  support_email   TEXT,
  support_phone   TEXT,
  mailing_address JSONB,
  timezone        TEXT DEFAULT 'America/New_York',

  -- Configuration
  ai_mode TEXT NOT NULL DEFAULT 'autonomous'
    CHECK (ai_mode IN ('autonomous','draft_only','disabled')),

  is_sandbox BOOLEAN DEFAULT FALSE,

  -- Onboarding stage
  onboarding_stage      TEXT,
  signup_completed_at   TIMESTAMPTZ,
  review_started_at     TIMESTAMPTZ,
  activated_at          TIMESTAMPTZ,
  suspended_at          TIMESTAMPTZ,
  suspended_reason      TEXT,
  terminated_at         TIMESTAMPTZ,
  terminated_reason     TEXT,

  -- Legal acceptance
  ica_accepted_at  TIMESTAMPTZ,
  w9_received_at   TIMESTAMPTZ,

  -- Audit
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX tenants_status_idx ON public.tenants(status);
CREATE INDEX tenants_type_idx   ON public.tenants(tenant_type);

-- ---------------------------------------------------------------------------
-- users — per spec §5.1
-- ---------------------------------------------------------------------------

CREATE TABLE public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  auth_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,

  email        TEXT NOT NULL,
  display_name TEXT,
  first_name   TEXT,
  last_name    TEXT,

  auth_provider TEXT CHECK (auth_provider IN ('google','microsoft','facebook')),

  -- Preferences
  preferred_persona_slug   TEXT,
  marketing_email_opt_in   BOOLEAN DEFAULT FALSE,
  travel_news_opt_in       BOOLEAN DEFAULT FALSE,
  memory_opt_out           BOOLEAN DEFAULT FALSE,
  notif_preferences        JSONB DEFAULT '{}'::jsonb,

  -- Status
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','deleted')),

  email_status TEXT DEFAULT 'active'
    CHECK (email_status IN ('active','invalid','soft_failing','complained','unsubscribed_all')),

  deleted_at TIMESTAMPTZ,

  -- Audit
  last_signed_in_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (tenant_id, auth_user_id)
);

CREATE UNIQUE INDEX users_tenant_email_unique_idx
  ON public.users(tenant_id, email) WHERE email IS NOT NULL;

CREATE INDEX users_status_idx ON public.users(status);

-- ---------------------------------------------------------------------------
-- Hard-delete protection — per spec §5.1.X
--
-- Tenants are soft-terminated (status='terminated'), not deleted. The combo
-- of FK ON DELETE RESTRICT and this trigger makes accidental hard delete
-- structurally difficult. Legitimate hard delete (GDPR right-to-be-forgotten,
-- regulatory order) requires the SET LOCAL override below within a txn.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prevent_tenant_hard_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_setting('app.allow_tenant_hard_delete', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Hard delete of tenants is not permitted. Use status = ''terminated'' instead. To override (e.g., for compliance hard-delete after data retention period), execute SET app.allow_tenant_hard_delete = ''true'' in the same transaction.';
END;
$$;

CREATE TRIGGER tenant_prevent_delete_trigger
  BEFORE DELETE ON public.tenants
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_tenant_hard_delete();
