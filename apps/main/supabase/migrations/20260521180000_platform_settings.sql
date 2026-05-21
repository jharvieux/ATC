-- §6.10: platform_settings — platform-wide configurable knobs
--
-- Lives in the main app's Supabase project. The canonical values for all
-- platform-wide settings are here; the RAG project holds a replica for its
-- local plpgsql function use (see apps/rag/supabase/migrations/0006).
--
-- RLS:
--   SELECT: any authenticated user (platform config is not secret)
--   INSERT/UPDATE/DELETE: nobody via RLS — changes go through
--   withPlatformAdminAudit(...) paths under service role, which bypasses RLS.
--
-- No tenant_id column — this is platform-scoped, not tenant-scoped.

CREATE TABLE public.platform_settings (
  key               TEXT        PRIMARY KEY,
  value             JSONB       NOT NULL,
  description       TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_id UUID       REFERENCES public.users(id)
);

-- Seed: four feedback knobs from §6.10
INSERT INTO public.platform_settings (key, value, description)
VALUES
  ('feedback_adjustment_limit',    '0.05'::JSONB, 'Max signed adjustment to retrieval score from feedback (per §6.10)'),
  ('feedback_min_signal_count',    '2'::JSONB,    'Minimum signal count to trigger any feedback adjustment (per §6.10)'),
  ('feedback_period_days',         '30'::JSONB,   'Lookback window for minimum signal count check (per §6.10)'),
  ('feedback_decay_halflife_days', '90'::JSONB,   'Halflife for exponential decay of older feedback signals (per §6.10)');

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read platform settings.
CREATE POLICY platform_settings_select_policy ON public.platform_settings
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- No INSERT/UPDATE/DELETE policies — RLS blocks user-initiated writes.
-- Changes are made exclusively via service_role (withPlatformAdminAudit paths),
-- which bypasses RLS by design per §5.4.1.

-- ── Grants ──────────────────────────────────────────────────────────────────

GRANT SELECT ON public.platform_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_settings TO service_role;
