-- #781 Phase 2 Step 2 — canonical_match_reviews schema update.
--
-- Migration 20260630000002_ports.sql created canonical_match_reviews as part
-- of the catalog expansion. This migration updates it to the design shipped
-- by the backfill resolver: drops the stub-shaped occurrence_count/sources
-- aggregation columns (upsert with ignoreDuplicates never incremented them),
-- adds source_table + source_column for flat provenance, tightens entity_type
-- to only include types the resolver actually produces, adds platform-admin
-- RLS policies, and grants SELECT/UPDATE to authenticated for the admin UI.

-- ── Column changes ─────────────────────────────────────────────────────────────

-- Drop stub-shaped aggregation columns. The ports migration included these
-- for future occurrence counting, but queueForReview uses ignoreDuplicates
-- so they were always 1 and never updated (D-091 stub-shaped code).
ALTER TABLE public.canonical_match_reviews DROP COLUMN IF EXISTS occurrence_count;
ALTER TABLE public.canonical_match_reviews DROP COLUMN IF EXISTS sources;

-- Add flat provenance: which DB table + column produced this unmatched value.
-- DEFAULT '' for the ADD, then dropped so new rows must supply the value.
ALTER TABLE public.canonical_match_reviews ADD COLUMN IF NOT EXISTS source_table text NOT NULL DEFAULT '';
ALTER TABLE public.canonical_match_reviews ALTER COLUMN source_table DROP DEFAULT;

ALTER TABLE public.canonical_match_reviews ADD COLUMN IF NOT EXISTS source_column text NOT NULL DEFAULT '';
ALTER TABLE public.canonical_match_reviews ALTER COLUMN source_column DROP DEFAULT;

-- ── Constraint update ─────────────────────────────────────────────────────────

-- Tighten entity_type to types the resolver actually produces. The original
-- ports migration included 'port' speculatively; no code path writes port reviews.
ALTER TABLE public.canonical_match_reviews
  DROP CONSTRAINT IF EXISTS canonical_match_reviews_entity_type_check;
ALTER TABLE public.canonical_match_reviews
  ADD CONSTRAINT canonical_match_reviews_entity_type_check
  CHECK (entity_type IN ('line', 'ship'));

-- ── Index refresh ─────────────────────────────────────────────────────────────

-- Replace the combined (status, entity_type) index with two targeted indexes.
DROP INDEX IF EXISTS public.canonical_match_reviews_status_idx;

CREATE INDEX IF NOT EXISTS canonical_match_reviews_status_idx
  ON public.canonical_match_reviews (status);
CREATE INDEX IF NOT EXISTS canonical_match_reviews_entity_status_idx
  ON public.canonical_match_reviews (entity_type, status);

-- ── RLS policies ───────────────────────────────────────────────────────────────

-- service_role bypasses RLS — no policy needed for it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'canonical_match_reviews'
      AND policyname = 'canonical_match_reviews_platform_admin_read'
  ) THEN
    CREATE POLICY canonical_match_reviews_platform_admin_read
      ON public.canonical_match_reviews
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.platform_admins
          WHERE platform_admins.auth_user_id = auth.uid()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'canonical_match_reviews'
      AND policyname = 'canonical_match_reviews_platform_admin_update'
  ) THEN
    CREATE POLICY canonical_match_reviews_platform_admin_update
      ON public.canonical_match_reviews
      FOR UPDATE
      USING (
        EXISTS (
          SELECT 1 FROM public.platform_admins
          WHERE platform_admins.auth_user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- ── Grants ────────────────────────────────────────────────────────────────────

-- authenticated needs SELECT + UPDATE so the admin UI can read the queue and
-- mark items mapped/ignored via PostgREST (RLS enforces platform_admin scope).
-- service_role already has full grants from the ports migration.
GRANT SELECT, UPDATE ON public.canonical_match_reviews TO authenticated;
