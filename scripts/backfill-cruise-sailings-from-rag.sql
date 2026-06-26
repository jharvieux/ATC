-- One-shot backfill: populate the main-app sailing catalog (cruise_sailings +
-- sailing_port_calls) from the RAG project's already-ingested itineraries.
--
-- Why: the group-booking line→ship→sailing dropdown reads cruise_sailings, which
-- was empty in prod (issue #1472 / D-302). The catalog is normally written as a
-- side-effect of the monthly CruiseMapper sailing cron, but the shared scrape
-- inventory's content-hashes are all stamped, so the cron's conditional GET skips
-- every page and the catalog never backfilled. RAG already holds every future
-- itinerary, so we copy from there instead of re-scraping.
--
-- Join key: RAG itineraries.ship (display name, e.g. "MSC World Asia") matches
-- main cruise_ships.canonical_name case-insensitively (227/237 distinct future
-- ships resolve; the rest are lines/ships not in main's catalog and are skipped).
--
-- Idempotent: ON CONFLICT upserts on both unique keys, so re-running is safe and
-- the monthly cron can keep maintaining rows afterward.
--
-- Run (from repo root, do not echo the URLs):
--   set -a; source .env.local; set +a
--   psql "$SUPABASE_RAG_DB_URL" -c "\copy (SELECT cruise_line, ship, departure_date, departure_port, duration_nights, region, starting_price_usd, ports_of_call FROM itineraries WHERE departure_date >= current_date) TO '/tmp/rag_future_itins.csv' WITH (FORMAT csv)"
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f scripts/backfill-cruise-sailings-from-rag.sql

BEGIN;

CREATE TEMP TABLE tmp_rag (
  cruise_line        text,
  ship               text,
  departure_date     date,
  departure_port     text,
  duration_nights    int,
  region             text,
  starting_price_usd numeric(10, 2),
  ports_of_call      text[]
) ON COMMIT DROP;

\copy tmp_rag FROM '/tmp/rag_future_itins.csv' WITH (FORMAT csv)

-- Resolve each itinerary to a main cruise_ships.id and collapse RAG's
-- (ship, date, port) grain to main's (ship, date) grain — pick the
-- alphabetically-first departure_port deterministically when a ship has two
-- same-day departures.
CREATE TEMP TABLE staged ON COMMIT DROP AS
SELECT DISTINCT ON (cs.id, t.departure_date)
  cs.id            AS cruise_ship_id,
  t.departure_date,
  t.departure_port,
  t.duration_nights,
  t.region,
  t.starting_price_usd,
  t.ports_of_call
FROM tmp_rag t
JOIN public.cruise_ships cs
  ON lower(cs.canonical_name) = lower(t.ship)
 AND cs.is_active
ORDER BY cs.id, t.departure_date, t.departure_port;

INSERT INTO public.cruise_sailings
  (cruise_ship_id, departure_date, departure_port, duration_nights, region, starting_price)
SELECT cruise_ship_id, departure_date, departure_port, duration_nights, region, starting_price_usd
FROM staged
ON CONFLICT (cruise_ship_id, departure_date) DO UPDATE
SET departure_port   = EXCLUDED.departure_port,
    duration_nights  = EXCLUDED.duration_nights,
    region           = EXCLUDED.region,
    starting_price   = EXCLUDED.starting_price,
    updated_at       = now();

-- Ports of call: one row per (sailing, day_index). day_index is 0-based to match
-- the live ingest (persistPortCalls maps the array index directly). port_id is
-- left NULL, exactly as the normal pipeline does.
INSERT INTO public.sailing_port_calls (sailing_id, port_name, day_index)
SELECT s.id, poc.port_name, (poc.ord - 1)::int
FROM staged st
JOIN public.cruise_sailings s
  ON s.cruise_ship_id = st.cruise_ship_id
 AND s.departure_date = st.departure_date
CROSS JOIN LATERAL unnest(st.ports_of_call) WITH ORDINALITY AS poc(port_name, ord)
WHERE st.ports_of_call IS NOT NULL
  AND array_length(st.ports_of_call, 1) > 0
ON CONFLICT (sailing_id, day_index) DO UPDATE
SET port_name = EXCLUDED.port_name;

-- Verification readout (printed inside the txn).
SELECT 'cruise_sailings_total'      AS metric, count(*)::text AS value FROM public.cruise_sailings
UNION ALL SELECT 'cruise_sailings_future', count(*)::text FROM public.cruise_sailings WHERE departure_date >= current_date
UNION ALL SELECT 'distinct_ships',         count(DISTINCT cruise_ship_id)::text FROM public.cruise_sailings
UNION ALL SELECT 'port_calls_total',       count(*)::text FROM public.sailing_port_calls;

COMMIT;
