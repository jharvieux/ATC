-- §21.10.1 Quote pricing discipline + §21.6 tenant chat-source visibility setting.
--
-- Adds:
--   1. quote_pricing columns on public.quotes (estimate vs confirmed,
--      price lock, customer-accepted variance, audit-snapshot id).
--   2. public.tenant_settings — new general-purpose per-tenant settings table.
--      Houses quote_variance_cents and show_chat_sources for now; future
--      tenant-level knobs go here too instead of being added to tenants.
--   3. priced_at column on quotes — when the price was originally locked/quoted.
--      Used by §21.10.1 kind-resolver (must be ≤ 15 minutes old to be CONFIRMED).
--   4. platform_settings row quote_estimate_validity_days = 7.
--
-- Note: customer_accepted_audit_id is declared as bare UUID (no FK) because
-- the audit_log table does not yet exist — audit writes are still stubbed to
-- console.warn per D-036. When §26 lands the audit_log table, a future
-- migration adds the FK. The column is still useful as a correlation handle.

-- ── 1. Quote pricing columns ─────────────────────────────────────────────────

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS price_kind                    TEXT
    CHECK (price_kind IN ('estimate','confirmed')) DEFAULT 'estimate',
  ADD COLUMN IF NOT EXISTS price_lock_token              TEXT,
  ADD COLUMN IF NOT EXISTS price_lock_expires_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_accepted_variance_cents BIGINT,
  ADD COLUMN IF NOT EXISTS customer_accepted_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS customer_accepted_audit_id    UUID,
  ADD COLUMN IF NOT EXISTS priced_at                     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS estimate_price_cents          BIGINT,
  ADD COLUMN IF NOT EXISTS locked_price_cents            BIGINT;

CREATE INDEX IF NOT EXISTS quotes_estimate_expiry_sweep_idx
  ON public.quotes (priced_at)
  WHERE price_kind = 'estimate' AND status = 'sent' AND customer_accepted_at IS NULL;

-- ── 2. tenant_settings table ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tenant_settings (
  tenant_id            UUID        PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  -- §21.10.1 — per-tenant accepted price variance on ESTIMATE quotes.
  quote_variance_cents BIGINT      NOT NULL DEFAULT 5000,
  -- §21.6 — controls visibility of the click-to-expand source-transparency UI.
  -- Persona still cites inline in prose regardless of this setting.
  show_chat_sources    BOOLEAN     NOT NULL DEFAULT TRUE,
  -- Audit
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.tenant_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_settings_select_policy ON public.tenant_settings
  FOR SELECT
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY tenant_settings_insert_policy ON public.tenant_settings
  FOR INSERT
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY tenant_settings_update_policy ON public.tenant_settings
  FOR UPDATE
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY tenant_settings_delete_policy ON public.tenant_settings
  FOR DELETE
  USING (FALSE);

GRANT SELECT, INSERT, UPDATE ON public.tenant_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_settings TO service_role;

-- ── 3. Platform settings seed ────────────────────────────────────────────────

INSERT INTO public.platform_settings (key, value, description)
VALUES
  ('quote_estimate_validity_days', '7'::JSONB,
    'Days an ESTIMATE quote remains valid before auto-expiry (§21.10.1)'),
  ('category_halflives_days',
    '{"pricing": 7, "promo": 14, "schedule": 30, "policy": 90}'::JSONB,
    'Half-life in days per category for §21.7 freshness caveats')
ON CONFLICT (key) DO NOTHING;
