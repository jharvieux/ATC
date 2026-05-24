-- BP33 §33.8.1 — price_watches table.
--
-- Tenant-scoped subscription rows for "alert me when this sailing's
-- price drops by X". Created in the subscriber UI (BP40); checked by
-- the daily Inngest job (BP38) which compares cached prices against
-- baselines and flips active → triggered.
--
-- Standard tenant-scoped RLS pattern (§1.5).

CREATE TABLE public.price_watches (
  watch_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  subscriber_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  booking_id         UUID NULL REFERENCES public.bookings(id) ON DELETE SET NULL,

  -- Sailing identification (denormalized; the watch row survives booking deletion).
  -- On booking deletion, booking_id becomes NULL and app logic / a trigger sets
  -- status = 'cancelled' per the §33.8.2 lifecycle.
  cruise_line        TEXT NOT NULL,
  ship               TEXT NOT NULL,
  sail_date          DATE NOT NULL,
  departure_port     TEXT NOT NULL,
  cabin_class        TEXT NOT NULL,

  -- Baseline (the price the subscriber is comparing against)
  baseline_price     NUMERIC(10,2) NOT NULL,
  baseline_currency  TEXT NOT NULL,
  baseline_set_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Trigger configuration (set by subscriber when creating the watch)
  threshold_kind     TEXT NOT NULL CHECK (threshold_kind IN ('dollar_drop','percent_drop','either')),
  dollar_threshold   NUMERIC(10,2) NULL,
  percent_threshold  NUMERIC(5,2) NULL, -- e.g., 10.00 means 10%

  -- Lifecycle
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','triggered','paused','expired','cancelled')),
  triggered_at       TIMESTAMPTZ NULL,
  notified_at        TIMESTAMPTZ NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT threshold_present
    CHECK ((threshold_kind = 'dollar_drop'  AND dollar_threshold  IS NOT NULL)
        OR (threshold_kind = 'percent_drop' AND percent_threshold IS NOT NULL)
        OR (threshold_kind = 'either'       AND dollar_threshold  IS NOT NULL AND percent_threshold IS NOT NULL))
);

CREATE INDEX idx_watches_tenant_status
  ON public.price_watches (tenant_id, status);
CREATE INDEX idx_watches_sailing
  ON public.price_watches (cruise_line, ship, sail_date)
  WHERE status = 'active';

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.price_watches ENABLE ROW LEVEL SECURITY;

CREATE POLICY price_watches_tenant_select ON public.price_watches
  FOR SELECT USING (public.auth_user_in_tenant(tenant_id));
CREATE POLICY price_watches_tenant_insert ON public.price_watches
  FOR INSERT WITH CHECK (public.auth_user_in_tenant(tenant_id));
CREATE POLICY price_watches_tenant_update ON public.price_watches
  FOR UPDATE USING (public.auth_user_in_tenant(tenant_id))
  WITH CHECK (public.auth_user_in_tenant(tenant_id));
CREATE POLICY price_watches_tenant_delete ON public.price_watches
  FOR DELETE USING (public.auth_user_in_tenant(tenant_id));
