-- BP36 §36 — Source-of-Business Reporting schema
--
-- Adds:
--   1. campaigns table (per-campaign cost data for cost-per-lead)
--   2. cancellation_reason_category enum on bookings (§36.5)
--   3. attribution_rollup materialized view (§36.6) + indexes
--
-- Depends on BP35's first_touch_* columns; apply BP35's migration first.

-- ── 36.4 campaigns ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  utm_campaign TEXT NOT NULL,
  display_name TEXT,
  campaign_cost_cents BIGINT,
  currency TEXT NOT NULL DEFAULT 'USD',
  campaign_start DATE,
  campaign_end   DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, utm_campaign)
);

CREATE INDEX IF NOT EXISTS campaigns_tenant_idx
  ON public.campaigns(tenant_id);

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY campaigns_select ON public.campaigns
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY campaigns_insert ON public.campaigns
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY campaigns_update ON public.campaigns
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY campaigns_delete ON public.campaigns
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaigns TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaigns TO service_role;

-- ── 36.5 cancellation_reason_category ─────────────────────────────────
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS cancellation_reason_category TEXT
    CHECK (cancellation_reason_category IS NULL OR cancellation_reason_category IN (
      'customer_change_of_mind',
      'medical',
      'family_emergency',
      'financial',
      'cruise_line_change',
      'weather_or_natural_disaster',
      'poor_prior_experience_with_line',
      'other'
    ));

CREATE INDEX IF NOT EXISTS bookings_cancel_category_idx
  ON public.bookings(tenant_id, cancellation_reason_category)
  WHERE cancellation_reason_category IS NOT NULL;

-- ── 36.6 attribution_rollup MV ────────────────────────────────────────
-- contacts has the primary key (no contact_id on bookings/quotes — they
-- reference primary_contact_id and contact_id respectively per existing
-- schema). The MV joins on the right FK names per the actual tables.
--
-- Existing schema sample (from inspection):
--   bookings.primary_contact_id  → contacts.id
--   quotes.contact_id            → contacts.id
DROP MATERIALIZED VIEW IF EXISTS public.attribution_rollup;
CREATE MATERIALIZED VIEW public.attribution_rollup AS
  SELECT
    c.tenant_id,
    DATE_TRUNC('day', c.created_at)::date AS day,
    c.first_touch_channel,
    c.first_touch_utm_source,
    c.first_touch_utm_medium,
    c.first_touch_utm_campaign,
    COUNT(DISTINCT c.id) AS contacts_acquired,
    COUNT(DISTINCT q.id) AS quotes_created,
    COUNT(DISTINCT b.id) FILTER (
      WHERE b.status NOT IN ('cancelled','draft')
    ) AS bookings_confirmed,
    COUNT(DISTINCT b.id) FILTER (
      WHERE b.status = 'cancelled'
    ) AS bookings_cancelled,
    COALESCE(SUM(cm.gross_commission_cents) FILTER (
      WHERE b.status NOT IN ('cancelled','draft')
    ), 0) AS gross_commission_cents,
    COALESCE(SUM(cm.net_commission_cents) FILTER (
      WHERE b.status NOT IN ('cancelled','draft')
    ), 0) AS net_commission_cents
  FROM public.contacts c
  LEFT JOIN public.quotes      q  ON q.contact_id        = c.id  AND q.tenant_id = c.tenant_id
  LEFT JOIN public.bookings    b  ON b.primary_contact_id = c.id  AND b.tenant_id = c.tenant_id
  LEFT JOIN public.commissions cm ON cm.booking_id       = b.id AND cm.tenant_id = c.tenant_id
  GROUP BY 1, 2, 3, 4, 5, 6;

-- NULL-safe unique index for CONCURRENTLY refresh: COALESCE so NULL
-- dimension columns participate in uniqueness predictably.
CREATE UNIQUE INDEX attribution_rollup_pk ON public.attribution_rollup(
  tenant_id, day,
  COALESCE(first_touch_channel, ''),
  COALESCE(first_touch_utm_source, ''),
  COALESCE(first_touch_utm_medium, ''),
  COALESCE(first_touch_utm_campaign, '')
);

CREATE INDEX attribution_rollup_tenant_day_idx
  ON public.attribution_rollup(tenant_id, day);
CREATE INDEX attribution_rollup_campaign_idx
  ON public.attribution_rollup(tenant_id, first_touch_utm_campaign)
  WHERE first_touch_utm_campaign IS NOT NULL;

-- Allow service-role to refresh + authenticated tenants to SELECT.
GRANT SELECT ON public.attribution_rollup TO authenticated;
GRANT SELECT ON public.attribution_rollup TO service_role;

-- Note: materialized views don't support RLS directly. Tenant isolation
-- for queries against this MV is enforced application-side via the
-- query helpers in apps/main/src/lib/reporting/.
COMMENT ON MATERIALIZED VIEW public.attribution_rollup IS
  'BP36 §36.6 — tenant-id is the leading column; application queries MUST filter on it. RLS does not apply to MVs.';

-- Refresh helper used by the Inngest nightly cron. SECURITY DEFINER so
-- the cron's service-role client can invoke without holding REFRESH
-- privilege directly on the MV. Restricted to service_role.
CREATE OR REPLACE FUNCTION public.refresh_attribution_rollup()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.attribution_rollup;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.refresh_attribution_rollup() FROM public;
GRANT EXECUTE ON FUNCTION public.refresh_attribution_rollup() TO service_role;
