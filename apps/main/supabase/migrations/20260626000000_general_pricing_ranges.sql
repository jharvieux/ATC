-- §33.4 D-088 — General pricing ranges (replaces Apify itinerary pricing).
--
-- DIY CruiseMapper scraper populates this table with low/high cabin-price
-- ranges per (cruise_line, ship, cabin_class, duration_nights). AI uses
-- these ranges for "approximately around" responses in chat per the
-- §33.7 rounding rule. Separate table from pricing_cache (which is
-- per-sailing) because a range has no specific sail_date.

CREATE TABLE IF NOT EXISTS public.general_pricing_ranges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cruise_line     TEXT NOT NULL,
  ship            TEXT NOT NULL,
  cabin_class     TEXT NOT NULL CHECK (cabin_class IN ('interior','oceanview','balcony','mini_suite','suite')),
  duration_nights INT NOT NULL,
  low_amount      NUMERIC(10,2) NOT NULL CHECK (low_amount >= 0),
  high_amount     NUMERIC(10,2) NOT NULL CHECK (high_amount >= low_amount),
  currency        TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  source          TEXT NOT NULL DEFAULT 'diy_cruisemapper' CHECK (source IN ('diy_cruisemapper','manual')),
  source_url      TEXT,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cruise_line, ship, cabin_class, duration_nights, source)
);

CREATE INDEX IF NOT EXISTS general_pricing_ranges_lookup_idx
  ON public.general_pricing_ranges (cruise_line, ship, duration_nights);

-- RLS — global reference data. Service-role writes only (the DIY ingest
-- cron); SELECT readable by any caller (chat path queries this for AI
-- context).
ALTER TABLE public.general_pricing_ranges ENABLE ROW LEVEL SECURITY;
CREATE POLICY general_pricing_ranges_select ON public.general_pricing_ranges
  FOR SELECT USING (TRUE);
-- No INSERT/UPDATE/DELETE policies — service-role bypasses RLS.
