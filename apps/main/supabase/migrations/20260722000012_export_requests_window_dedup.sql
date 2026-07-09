-- Migration: export_requests_window_dedup
-- Version:   20260722000012
-- Generated: 2026-07-09 by scripts/new-migration.sh
-- Branch:    feature/sweep-db-misc-1698
-- Worktree:  agent-a79f0cb75f2288c77
--
-- #1705 (D-091 #6/#23/#24) — DB-level backstop for the 30-day export
-- rate limit. The route (apps/main/src/app/api/user/data/export-request)
-- enforced "1 export per rolling 30 days" with a SELECT-then-INSERT and no DB
-- uniqueness, so two concurrent requests could both pass the SELECT gate and
-- both insert.
--
-- window_bucket is a coarse fixed 30-day bucket = floor(epoch_seconds /
-- 2592000), computed by the route and stored on insert. Two *concurrent*
-- requests carry near-identical timestamps → the same bucket → they collide on
-- the unique index below and exactly one wins (the loser gets 23505 → 429).
-- This is deliberately a race backstop, not the primary limiter: the app-layer
-- rolling-30-day SELECT remains the exact enforcement of the business rule
-- (fixed buckets alone would let a day-29/day-31 straddle through — the SELECT
-- catches that; the unique index catches the simultaneous-submit race the
-- SELECT cannot). It's set in the app rather than as a GENERATED column because
-- extract(epoch FROM timestamptz) is STABLE, not IMMUTABLE, so Postgres rejects
-- it in a generated-column expression.
--
-- Existing rows keep window_bucket NULL; NULLs are distinct in a unique index,
-- so the index builds cleanly against historical data with no dedupe step.

ALTER TABLE public.user_data_export_requests
  ADD COLUMN IF NOT EXISTS window_bucket BIGINT;

COMMENT ON COLUMN public.user_data_export_requests.window_bucket IS
  '#1705: 30-day rate-limit bucket = floor(epoch_seconds / 2592000), set by the export-request route. Backstops the app-layer rolling-30-day SELECT gate against the concurrent double-submit race via the unique index user_data_export_requests_user_window_uidx (collision → 23505 → 429). NULL for pre-#1705 rows.';

CREATE UNIQUE INDEX IF NOT EXISTS user_data_export_requests_user_window_uidx
  ON public.user_data_export_requests (auth_user_id, window_bucket);
