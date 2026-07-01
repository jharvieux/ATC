-- One-shot backfill: populate cruise_ships.{guest_capacity,decks,built_year}
-- from RAG's already-ingested ship_intel knowledge chunks.
--
-- Why: the group-landing redesign's ship-stats section (specs/design_handoff_
-- group_landing/) needs these fields, and main's cruise_ships has no source
-- for them. RAG's knowledge_chunks (category='ship_intel', ~725 rows) holds
-- free-text descriptions following a consistent template — e.g. "Britannia
-- is a cruise ship, operated by P&O UK (P&O Cruises), belonging to the Royal
-- class, built in 2015, at Fincantieri (Monfalcone, Italy), flagged in United
-- Kingdom. Dimensions: 143730 GT. Capacity: 3647 passengers, 1350 crew, 17
-- decks, 1837 cabins." — regex-parseable for built_year/passengers/decks on
-- ~99% of rows (716/725 matched the capacity pattern in manual inspection).
--
-- signature_feature is NOT populated here — no reliable structured source
-- exists (see issue #1565); it stays manually curated only.
--
-- Join key: RAG's ship_or_property matches main cruise_ships.canonical_name
-- case-insensitively, same approach as backfill-cruise-sailings-from-rag.sql
-- (D-303) — expect some ships won't resolve (name drift between the two
-- independently-maintained catalogs); those simply keep NULL stats, which is
-- spec-compliant (omit rather than fabricate).
--
-- Idempotent: only fills currently-NULL columns (COALESCE), so re-running is
-- safe and never clobbers a later manual correction (#1565) or a prior run.
--
-- Run (from repo root, do not echo the URLs):
--   set -a; source .env.local; set +a
--   psql "$SUPABASE_RAG_DB_URL" -c "\copy (SELECT ship_or_property, content FROM knowledge_chunks WHERE category = 'ship_intel' AND ship_or_property IS NOT NULL) TO '/tmp/rag_ship_intel.csv' WITH (FORMAT csv)"
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f scripts/backfill-ship-stats-from-rag.sql

BEGIN;

CREATE TEMP TABLE tmp_ship_intel (
  ship_or_property text,
  content          text
) ON COMMIT DROP;

\copy tmp_ship_intel FROM '/tmp/rag_ship_intel.csv' WITH (FORMAT csv)

-- Parse the free-text template into structured fields. One row per distinct
-- ship name (DISTINCT ON, first match wins) in case RAG has more than one
-- ship_intel chunk for the same ship.
CREATE TEMP TABLE staged ON COMMIT DROP AS
SELECT DISTINCT ON (cs.id)
  cs.id                                                     AS cruise_ship_id,
  substring(t.content from 'built in (\d{4})')::int         AS built_year,
  (regexp_match(t.content, 'Capacity: \d+ passengers, (\d+) crew, (\d+) decks'))[2]::int AS decks,
  (regexp_match(t.content, 'Capacity: (\d+) passengers'))[1]::int AS guest_capacity
FROM tmp_ship_intel t
JOIN public.cruise_ships cs
  ON lower(cs.canonical_name) = lower(t.ship_or_property)
 AND cs.is_active
WHERE t.content ~ 'Capacity: \d+ passengers, \d+ crew, \d+ decks'
ORDER BY cs.id, t.ship_or_property;

UPDATE public.cruise_ships cs
SET guest_capacity = COALESCE(cs.guest_capacity, staged.guest_capacity),
    decks           = COALESCE(cs.decks, staged.decks),
    built_year      = COALESCE(cs.built_year, staged.built_year),
    updated_at      = now()
FROM staged
WHERE cs.id = staged.cruise_ship_id;

-- Verification readout (printed inside the txn).
SELECT 'ship_intel_rows_matched' AS metric, count(*)::text AS value FROM staged
UNION ALL SELECT 'cruise_ships_with_stats', count(*)::text FROM public.cruise_ships
  WHERE guest_capacity IS NOT NULL OR decks IS NOT NULL OR built_year IS NOT NULL
UNION ALL SELECT 'cruise_ships_total', count(*)::text FROM public.cruise_ships WHERE is_active;

COMMIT;
