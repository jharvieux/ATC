-- #781 Phase 2 Step 2 — canonical_match_reviews table.
--
-- Holds free-text values that resolveCanonical() could not match to a
-- canonical cruise_line or cruise_ship row. Platform admins review and either:
--   - Map → inserts an alias row + triggers immediate re-backfill for that value.
--   - Ignore → marks junk/N/A values so the backfill skips them.
--
-- Each approved mapping makes future resolveCanonical() calls self-improving
-- (the new alias row is now reachable on the next run).

CREATE TABLE public.canonical_match_reviews (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type      text        NOT NULL CHECK (entity_type IN ('line', 'ship', 'port')),
  value_normalized text        NOT NULL,
  value_raw        text        NOT NULL,
  occurrence_count integer     NOT NULL DEFAULT 1,
  sources          jsonb       NOT NULL DEFAULT '[]',  -- [{table, column, count}]
  suggested_id     uuid,        -- nullable; AI/trigram suggestion for admin UI
  suggestion_note  text,
  status           text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'mapped', 'ignored')),
  resolved_by      uuid        REFERENCES public.users(id),
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, value_normalized)
);

CREATE INDEX canonical_match_reviews_status_idx
  ON public.canonical_match_reviews (status);
CREATE INDEX canonical_match_reviews_entity_status_idx
  ON public.canonical_match_reviews (entity_type, status);

ALTER TABLE public.canonical_match_reviews ENABLE ROW LEVEL SECURITY;

-- Platform admins can read all pending items and resolve them.
CREATE POLICY canonical_match_reviews_platform_admin_read
  ON public.canonical_match_reviews
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.platform_admins
      WHERE platform_admins.auth_user_id = auth.uid()
    )
  );

CREATE POLICY canonical_match_reviews_platform_admin_update
  ON public.canonical_match_reviews
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.platform_admins
      WHERE platform_admins.auth_user_id = auth.uid()
    )
  );

-- Service role owns inserts and bulk updates (backfill job).
GRANT SELECT, INSERT, UPDATE ON public.canonical_match_reviews TO service_role;
-- Authenticated gets SELECT only + UPDATE for admin-UI approvals (RLS gates it).
GRANT SELECT, UPDATE ON public.canonical_match_reviews TO authenticated;
