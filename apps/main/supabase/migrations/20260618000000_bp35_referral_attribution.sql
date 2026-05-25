-- BP35 §35 — Referral Source Attribution
--
-- Three storage locations per §35.1:
--   1. contacts.first_touch_*   — immutable acquisition attribution
--   2. attribution_touches      — rolling 10-touch table per contact
--   3. quotes/bookings.conversion_touch_* — snapshot at conversion
--
-- All RLS follows §5.1 auth_user_in_tenant + tenant_is_active.

-- ── 35.3 contacts first-touch columns ─────────────────────────────────
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS first_touch_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_touch_source_origin TEXT
    CHECK (first_touch_source_origin IS NULL OR first_touch_source_origin IN ('utm_parsed','agent_set','imported')),
  ADD COLUMN IF NOT EXISTS first_touch_utm_source   TEXT,
  ADD COLUMN IF NOT EXISTS first_touch_utm_medium   TEXT,
  ADD COLUMN IF NOT EXISTS first_touch_utm_campaign TEXT,
  ADD COLUMN IF NOT EXISTS first_touch_utm_content  TEXT,
  ADD COLUMN IF NOT EXISTS first_touch_utm_term     TEXT,
  ADD COLUMN IF NOT EXISTS first_touch_referrer_url TEXT,
  ADD COLUMN IF NOT EXISTS first_touch_landing_path TEXT,
  ADD COLUMN IF NOT EXISTS first_touch_channel      TEXT,
  ADD COLUMN IF NOT EXISTS first_touch_manual_label TEXT,
  ADD COLUMN IF NOT EXISTS first_touch_manual_category TEXT;

CREATE INDEX IF NOT EXISTS contacts_first_touch_campaign_idx
  ON public.contacts(tenant_id, first_touch_utm_campaign)
  WHERE first_touch_utm_campaign IS NOT NULL;

CREATE INDEX IF NOT EXISTS contacts_first_touch_channel_idx
  ON public.contacts(tenant_id, first_touch_channel);

-- ── 35.4 attribution_touches rolling table ────────────────────────────
CREATE TABLE IF NOT EXISTS public.attribution_touches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES public.tenants(id),
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,

  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_origin TEXT NOT NULL
    CHECK (source_origin IN ('utm_parsed','agent_set','agent_edit','imported')),

  utm_source   TEXT,
  utm_medium   TEXT,
  utm_campaign TEXT,
  utm_content  TEXT,
  utm_term     TEXT,
  referrer_url TEXT,
  landing_path TEXT,
  channel      TEXT,

  manual_label    TEXT,
  manual_category TEXT,
  editor_user_id  UUID REFERENCES public.users(id),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS attr_touches_contact_idx
  ON public.attribution_touches(tenant_id, contact_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS attr_touches_campaign_idx
  ON public.attribution_touches(tenant_id, utm_campaign, occurred_at)
  WHERE utm_campaign IS NOT NULL;

ALTER TABLE public.attribution_touches ENABLE ROW LEVEL SECURITY;

CREATE POLICY attribution_touches_select ON public.attribution_touches
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY attribution_touches_insert ON public.attribution_touches
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY attribution_touches_delete ON public.attribution_touches
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

GRANT SELECT, INSERT, DELETE ON public.attribution_touches TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.attribution_touches TO service_role;

-- ── 35.4.2 trigger: trim to 10 most recent per contact ────────────────
CREATE OR REPLACE FUNCTION public.attribution_touches_trim_to_ten()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.attribution_touches
  WHERE contact_id = NEW.contact_id
    AND id NOT IN (
      SELECT id
      FROM public.attribution_touches
      WHERE contact_id = NEW.contact_id
      ORDER BY occurred_at DESC, created_at DESC
      LIMIT 10
    );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attribution_touches_trim ON public.attribution_touches;
CREATE TRIGGER trg_attribution_touches_trim
  AFTER INSERT ON public.attribution_touches
  FOR EACH ROW
  EXECUTE FUNCTION public.attribution_touches_trim_to_ten();

-- ── 35.6 conversion_touch columns on quotes + bookings ────────────────
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS conversion_touch_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS conversion_touch_source_origin TEXT,
  ADD COLUMN IF NOT EXISTS conversion_touch_utm_source   TEXT,
  ADD COLUMN IF NOT EXISTS conversion_touch_utm_medium   TEXT,
  ADD COLUMN IF NOT EXISTS conversion_touch_utm_campaign TEXT,
  ADD COLUMN IF NOT EXISTS conversion_touch_utm_content  TEXT,
  ADD COLUMN IF NOT EXISTS conversion_touch_utm_term     TEXT,
  ADD COLUMN IF NOT EXISTS conversion_touch_referrer_url TEXT,
  ADD COLUMN IF NOT EXISTS conversion_touch_landing_path TEXT,
  ADD COLUMN IF NOT EXISTS conversion_touch_channel      TEXT,
  ADD COLUMN IF NOT EXISTS conversion_touch_manual_label TEXT,
  ADD COLUMN IF NOT EXISTS conversion_touch_manual_category TEXT;

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS conversion_touch_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS conversion_touch_source_origin TEXT,
  ADD COLUMN IF NOT EXISTS conversion_touch_utm_source   TEXT,
  ADD COLUMN IF NOT EXISTS conversion_touch_utm_medium   TEXT,
  ADD COLUMN IF NOT EXISTS conversion_touch_utm_campaign TEXT,
  ADD COLUMN IF NOT EXISTS conversion_touch_utm_content  TEXT,
  ADD COLUMN IF NOT EXISTS conversion_touch_utm_term     TEXT,
  ADD COLUMN IF NOT EXISTS conversion_touch_referrer_url TEXT,
  ADD COLUMN IF NOT EXISTS conversion_touch_landing_path TEXT,
  ADD COLUMN IF NOT EXISTS conversion_touch_channel      TEXT,
  ADD COLUMN IF NOT EXISTS conversion_touch_manual_label TEXT,
  ADD COLUMN IF NOT EXISTS conversion_touch_manual_category TEXT;

CREATE INDEX IF NOT EXISTS quotes_conv_campaign_idx
  ON public.quotes(tenant_id, conversion_touch_utm_campaign)
  WHERE conversion_touch_utm_campaign IS NOT NULL;

CREATE INDEX IF NOT EXISTS bookings_conv_campaign_idx
  ON public.bookings(tenant_id, conversion_touch_utm_campaign)
  WHERE conversion_touch_utm_campaign IS NOT NULL;

CREATE INDEX IF NOT EXISTS bookings_conv_channel_idx
  ON public.bookings(tenant_id, conversion_touch_channel);

-- ── 35.7.1 tenant-configurable manual category list ───────────────────
CREATE TABLE IF NOT EXISTS public.tenant_attribution_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  category_label TEXT NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, category_label)
);

CREATE INDEX IF NOT EXISTS tenant_attr_categories_tenant_idx
  ON public.tenant_attribution_categories(tenant_id, display_order)
  WHERE is_active;

ALTER TABLE public.tenant_attribution_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_attr_categories_select ON public.tenant_attribution_categories
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY tenant_attr_categories_insert ON public.tenant_attribution_categories
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY tenant_attr_categories_update ON public.tenant_attribution_categories
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY tenant_attr_categories_delete ON public.tenant_attribution_categories
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_attribution_categories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_attribution_categories TO service_role;

-- ── seed default categories for new tenants ───────────────────────────
-- These defaults come from §35.7.1.
CREATE OR REPLACE FUNCTION public.seed_attribution_categories_for_tenant(p_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.tenant_attribution_categories (tenant_id, category_label, display_order)
  VALUES
    (p_tenant_id, 'Past client referral', 10),
    (p_tenant_id, 'Facebook',             20),
    (p_tenant_id, 'Instagram',            30),
    (p_tenant_id, 'Trade show / networking event', 40),
    (p_tenant_id, 'Phone walk-in',        50),
    (p_tenant_id, 'Email referral',       60),
    (p_tenant_id, 'Other',                70)
  ON CONFLICT (tenant_id, category_label) DO NOTHING;
END;
$$;

-- Backfill: seed for every existing tenant.
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT id FROM public.tenants LOOP
    PERFORM public.seed_attribution_categories_for_tenant(t.id);
  END LOOP;
END;
$$;
