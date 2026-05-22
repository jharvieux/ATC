-- §16.1 / §16.3.5 / §16.6 — White-label branding, custom domain state machine, persona addendums.
--
-- Three things in one migration:
--   1. tenant_branding (§16.1) — per-tenant visual brand + email-from config
--   2. tenants additions (§16.3.5) — custom domain state-machine columns
--   3. persona_addendums (§16.6) — Haiku-screened persona positioning content

-- ── tenant_branding ──────────────────────────────────────────────────────────
CREATE TABLE public.tenant_branding (
  id                              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  -- Visual
  logo_url                        TEXT,
  logo_dark_url                   TEXT,
  favicon_url                     TEXT,
  primary_color                   TEXT,
  secondary_color                 TEXT,
  accent_color                    TEXT,
  font_family                     TEXT,
  slogan                          TEXT,
  about_text                      TEXT,
  -- Email
  email_send_pattern              TEXT        NOT NULL DEFAULT 'platform_resend'
    CHECK (email_send_pattern IN ('platform_resend','tenant_resend')),
  tenant_resend_api_key_encrypted TEXT,
  email_from_domain               TEXT,
  email_from_domain_verified_at   TIMESTAMPTZ,
  email_from_address              TEXT,
  email_from_name                 TEXT,
  -- Attribution
  show_powered_by                 BOOLEAN     NOT NULL DEFAULT TRUE,
  -- Audit
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id)
);

CREATE INDEX tenant_branding_tenant_id_idx ON public.tenant_branding(tenant_id);

ALTER TABLE public.tenant_branding ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_branding_select ON public.tenant_branding
  FOR SELECT USING (tenant_id IN (SELECT tenant_id FROM public.users WHERE auth_user_id = auth.uid()));
CREATE POLICY tenant_branding_insert ON public.tenant_branding
  FOR INSERT WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.users WHERE auth_user_id = auth.uid()));
CREATE POLICY tenant_branding_update ON public.tenant_branding
  FOR UPDATE USING (tenant_id IN (SELECT tenant_id FROM public.users WHERE auth_user_id = auth.uid()));
CREATE POLICY tenant_branding_delete ON public.tenant_branding
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE ON public.tenant_branding TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_branding TO service_role;

-- ── tenants — custom domain state machine ────────────────────────────────────
-- Per §16.3.5. The existing custom_domain (from BP04) and custom_domain_verified_at
-- (added below if missing) remain. The status column makes the state explicit.
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS custom_domain_verification_token TEXT,
  ADD COLUMN IF NOT EXISTS custom_domain_status TEXT NOT NULL DEFAULT 'none'
    CHECK (custom_domain_status IN (
      'none','pending_verification','verified',
      'cname_drifted','txt_drifted','txt_grace_expired','unbound_lifecycle'
    )),
  ADD COLUMN IF NOT EXISTS custom_domain_last_reverified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS custom_domain_unbound_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS custom_domain_verified_at TIMESTAMPTZ;

-- ── persona_addendums (§16.6) ────────────────────────────────────────────────
-- Per-tenant per-persona positioning content. Haiku-screened, status-tracked.
-- Uses persona_slug (not persona_id) because the personas table does not yet
-- exist — personas are defined as code-side base blocks (see BP10). Document
-- in MEMORY: deviation from spec §16.6 wording.
CREATE TABLE public.persona_addendums (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  persona_slug        TEXT        NOT NULL,
  content             TEXT        NOT NULL CHECK (LENGTH(content) <= 2000),
  haiku_screen_result JSONB,
  haiku_screened_at   TIMESTAMPTZ,
  status              TEXT        NOT NULL DEFAULT 'pending_screen'
    CHECK (status IN ('pending_screen','approved','suspended','rejected')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, persona_slug)
);

CREATE INDEX persona_addendums_tenant_idx ON public.persona_addendums(tenant_id);
CREATE INDEX persona_addendums_status_idx ON public.persona_addendums(status) WHERE status = 'approved';

ALTER TABLE public.persona_addendums ENABLE ROW LEVEL SECURITY;

CREATE POLICY persona_addendums_select ON public.persona_addendums
  FOR SELECT USING (tenant_id IN (SELECT tenant_id FROM public.users WHERE auth_user_id = auth.uid()));
CREATE POLICY persona_addendums_insert ON public.persona_addendums
  FOR INSERT WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.users WHERE auth_user_id = auth.uid()));
CREATE POLICY persona_addendums_update ON public.persona_addendums
  FOR UPDATE USING (tenant_id IN (SELECT tenant_id FROM public.users WHERE auth_user_id = auth.uid()));
CREATE POLICY persona_addendums_delete ON public.persona_addendums
  FOR DELETE USING (tenant_id IN (SELECT tenant_id FROM public.users WHERE auth_user_id = auth.uid()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.persona_addendums TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.persona_addendums TO service_role;
