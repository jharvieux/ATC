-- Migration: attribution_rollup_concurrent_refresh_index (fix #2018)
-- Version:   20260722000029
-- Generated: 2026-07-19 by scripts/new-migration.sh
--
-- WHAT: replace attribution_rollup's expression unique index
--   (attribution_rollup_pk, built on COALESCE(first_touch_*, '')) with a
--   plain-column unique index using NULLS NOT DISTINCT.
--
-- WHY: REFRESH MATERIALIZED VIEW CONCURRENTLY requires the qualifying unique
--   index to use ONLY column names — no expressions, no WHERE. The COALESCE()
--   in attribution_rollup_pk is an expression, so the nightly
--   refresh_attribution_rollup() RPC (Inngest cron, 03:00 UTC) has failed every
--   night since 20260619000000 with "cannot refresh materialized view ...
--   concurrently". NULLS NOT DISTINCT (PG15+; atc-main is PG 17.6) gives the
--   same NULL-safe uniqueness the COALESCE reached for — two rollup rows that
--   differ only by a NULL dimension are still treated as duplicates — but as a
--   plain-column index it QUALIFIES for concurrent refresh. The MV's GROUP BY
--   already guarantees one row per (tenant_id, day, dims) tuple, so no existing
--   data can violate the new constraint.
--
-- NO DATA LOSS: the MV itself is untouched — only the index is swapped, so no
--   rollup rows are dropped. (A full DROP/CREATE of the MV would also be safe
--   since it repopulates on the next refresh, but that is unnecessary here.)
--
-- RE-RUNNABLE: DROP INDEX IF EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS. On a
--   from-scratch DB the 20260619000000 migration creates attribution_rollup_pk
--   first; this migration then drops it and installs attribution_rollup_uidx.
--
-- No CONCURRENTLY here (runbook rule 3: multi-statement migrations run in one
-- pipeline where CREATE INDEX CONCURRENTLY errors 25001). The MV is tiny by
-- construction (currently 0 rows in prod), so the plain-build lock is
-- negligible. Index-only change — no policy/grant delta, so no snapshot regen
-- (runbook rule 1).

DROP INDEX IF EXISTS public.attribution_rollup_pk;

CREATE UNIQUE INDEX IF NOT EXISTS attribution_rollup_uidx
  ON public.attribution_rollup (
    tenant_id,
    day,
    first_touch_channel,
    first_touch_utm_source,
    first_touch_utm_medium,
    first_touch_utm_campaign
  ) NULLS NOT DISTINCT;
