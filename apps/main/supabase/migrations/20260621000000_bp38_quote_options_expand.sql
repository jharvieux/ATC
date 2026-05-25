-- BP38 §38 — Multi-Option Quote Builder
--
-- Deploy 1 (EXPAND): create quote_options + new container columns on
-- quotes. Per-option columns remain on quotes for dual-write coverage.

CREATE TABLE IF NOT EXISTS public.quote_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  quote_id  UUID NOT NULL REFERENCES public.quotes(id)  ON DELETE CASCADE,

  option_index INT NOT NULL,
  label TEXT,

  cruise_line TEXT,
  ship_name TEXT,
  sailing_date DATE,
  duration_nights INTEGER,
  departure_port TEXT,
  cabin_category TEXT,
  passenger_count INTEGER,

  commissionable_fare_cents BIGINT,
  non_commissionable_total_cents BIGINT,
  total_amount_cents BIGINT,
  currency TEXT NOT NULL DEFAULT 'USD',

  line_items JSONB,

  is_recommended BOOLEAN NOT NULL DEFAULT FALSE,
  customer_selected BOOLEAN NOT NULL DEFAULT FALSE,
  customer_selected_at TIMESTAMPTZ,

  option_notes TEXT,
  pros TEXT[],
  cons TEXT[],

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (quote_id, option_index)
);

CREATE INDEX IF NOT EXISTS quote_options_quote_idx ON public.quote_options(quote_id, option_index);
CREATE INDEX IF NOT EXISTS quote_options_tenant_idx ON public.quote_options(tenant_id);

-- §38.2.1 — at most one selected per quote.
CREATE UNIQUE INDEX IF NOT EXISTS quote_options_one_selected_idx
  ON public.quote_options(quote_id)
  WHERE customer_selected = TRUE;

ALTER TABLE public.quote_options ENABLE ROW LEVEL SECURITY;

CREATE POLICY quote_options_select ON public.quote_options
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY quote_options_insert ON public.quote_options
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY quote_options_update ON public.quote_options
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY quote_options_delete ON public.quote_options
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.quote_options TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quote_options TO service_role;

-- New container-level columns on quotes.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS customer_facing_intro TEXT,
  ADD COLUMN IF NOT EXISTS show_recommendation BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS recommendation_rationale TEXT;
