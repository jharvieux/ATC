-- BP33 §33.2 / §33.3 — pricing_cache table.
--
-- Platform-scoped reference table fed by the PricingDataSource adapter
-- (Apify per-cruise-line scrapers, BP34/35). Shared across all tenants —
-- pricing is reference data, not tenant-owned.
--
-- US-MARKET ONLY at launch. price_currency CHECK enforces USD; the
-- UNIQUE constraint has no market dimension.
--
-- RLS DELIBERATELY DISABLED — only the Apify adapter (service-role) reads
-- and writes this table. Customer-facing reads happen through the
-- consumer surface (BP39), which composes pricing into chat answers via
-- code paths, not direct table reads. If a tenant-scoped variant ever
-- ships, it goes in a separate table; do not weld a tenant_id onto this
-- one. Listed in db/rls-exceptions.txt with the same rationale.

CREATE TABLE public.pricing_cache (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cruise_line     TEXT NOT NULL,
  ship            TEXT NOT NULL,
  sail_date       DATE NOT NULL,
  departure_port  TEXT NOT NULL,
  duration_nights INTEGER NOT NULL CHECK (duration_nights > 0),
  cabin_class     TEXT NOT NULL CHECK (cabin_class IN ('interior','oceanview','balcony','mini_suite','suite')),
  price_amount    NUMERIC(10,2) NOT NULL CHECK (price_amount >= 0),
  price_currency  TEXT NOT NULL CHECK (price_currency = 'USD'),
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source          TEXT NOT NULL,
  actor_run_id    TEXT NULL,
  raw_payload     JSONB NULL,
  CONSTRAINT pricing_cache_unique_sailing UNIQUE (cruise_line, ship, sail_date, departure_port, duration_nights, cabin_class)
);

-- Lookup index for the (line, ship, date, cabin) hot path the
-- PricingDataSource adapter reads.
CREATE INDEX idx_pricing_cache_lookup
  ON public.pricing_cache (cruise_line, ship, sail_date, cabin_class);

-- Staleness queries (the daily refresh job picks rows whose fetched_at
-- has aged past the freshness window).
CREATE INDEX idx_pricing_cache_fetched_at
  ON public.pricing_cache (fetched_at);
