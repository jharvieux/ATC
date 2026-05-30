-- §23.4 — weather integration tables (Open-Meteo).
--
-- Two tables + one platform_settings seed:
--
--   weather_forecast_cache:
--     6h-TTL cache of Open-Meteo responses keyed on (port_id, forecast_date).
--     Read by the email-generation cron when assembling PreCruiseT1; written
--     by the helper after a successful fetch. TTL is enforced by the helper
--     (compares fetched_at against NOW() - 6h), not by the DB — letting the
--     cache row persist past TTL means a degraded run (Open-Meteo outage)
--     can still serve stale data with an explicit "stale" hint.
--
--   weather_usage_metrics:
--     One row per UTC date. Counter rolls over implicitly when a new date's
--     first request arrives (no reset cron needed). Used by the rate-limit
--     gate (today's row) AND by the 30-day admin usage chart (historical
--     rows).
--
--   platform_settings.weather_daily_request_cap:
--     Operator-tunable daily cap. Default 8000 leaves 2000-req headroom
--     under Open-Meteo's free-tier ceiling of 10000/day.
--
-- RLS:
--   Both tables are platform-internal: service-role writes, no user access.
--   The admin /integrations/weather page reads via service-role through
--   the /api/admin route (lands in PR B).

CREATE TABLE public.weather_forecast_cache (
  port_id           TEXT        NOT NULL,
  forecast_date     DATE        NOT NULL,
  payload           JSONB       NOT NULL,
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (port_id, forecast_date)
);

CREATE INDEX weather_forecast_cache_fetched_at_idx
  ON public.weather_forecast_cache (fetched_at);

CREATE TABLE public.weather_usage_metrics (
  metric_date       DATE        PRIMARY KEY,
  requests_count    INTEGER     NOT NULL DEFAULT 0,
  last_request_at   TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- §6.10 — seed the daily cap. JSONB-encoded number to match the
-- platform_settings.value column type. ON CONFLICT lets the migration
-- re-apply cleanly on a DB that already has the row (e.g., reset to
-- previous staging snapshot).
INSERT INTO public.platform_settings (key, value, description)
VALUES (
  'weather_daily_request_cap',
  '8000'::JSONB,
  'Open-Meteo daily request cap. Free tier is 10000/day; default leaves 2000 headroom.'
)
ON CONFLICT (key) DO NOTHING;

-- ── Atomic increment RPC ────────────────────────────────────────────────────
--
-- The rate-limit gate needs read-then-write to be race-free under concurrent
-- email-generation runs. ON CONFLICT … UPDATE on a per-date PK gives us
-- atomicity within a single statement. Returns the post-increment count so
-- the caller knows the new running total.

CREATE OR REPLACE FUNCTION public.increment_weather_usage()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  new_count INTEGER;
BEGIN
  INSERT INTO public.weather_usage_metrics (metric_date, requests_count, last_request_at)
  VALUES (CURRENT_DATE, 1, NOW())
  ON CONFLICT (metric_date) DO UPDATE
  SET requests_count = public.weather_usage_metrics.requests_count + 1,
      last_request_at = NOW(),
      updated_at = NOW()
  RETURNING requests_count INTO new_count;
  RETURN new_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.increment_weather_usage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_weather_usage() TO service_role;

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.weather_forecast_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weather_usage_metrics ENABLE ROW LEVEL SECURITY;

-- Explicit deny policies (§30.8 migration-lint rule: don't rely on
-- "no policy = deny").

CREATE POLICY weather_forecast_cache_no_user_select ON public.weather_forecast_cache
  FOR SELECT USING (FALSE);
CREATE POLICY weather_forecast_cache_no_user_insert ON public.weather_forecast_cache
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY weather_forecast_cache_no_user_update ON public.weather_forecast_cache
  FOR UPDATE USING (FALSE);
CREATE POLICY weather_forecast_cache_no_user_delete ON public.weather_forecast_cache
  FOR DELETE USING (FALSE);

CREATE POLICY weather_usage_metrics_no_user_select ON public.weather_usage_metrics
  FOR SELECT USING (FALSE);
CREATE POLICY weather_usage_metrics_no_user_insert ON public.weather_usage_metrics
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY weather_usage_metrics_no_user_update ON public.weather_usage_metrics
  FOR UPDATE USING (FALSE);
CREATE POLICY weather_usage_metrics_no_user_delete ON public.weather_usage_metrics
  FOR DELETE USING (FALSE);

-- ── Grants ──────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.weather_forecast_cache TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.weather_usage_metrics TO service_role;
