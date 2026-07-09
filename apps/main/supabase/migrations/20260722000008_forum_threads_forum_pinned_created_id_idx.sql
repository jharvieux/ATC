-- Migration: forum_threads_forum_pinned_created_id_idx
-- Version:   20260722000008
-- Generated: 2026-07-09 by scripts/new-migration.sh
-- Branch:    feature/sweep-db-misc-1698
-- Worktree:  agent-a79f0cb75f2288c77
--
-- #1714 (#1588/#1701 follow-up) — covering composite index for the forum
-- threads list route. The route filters `forum_id` (+ tenant_id + deleted_at
-- IS NULL) and orders `is_pinned` DESC, `created_at` DESC, then `id` ASC as a
-- page-stable tiebreaker for its `.range()` pagination. forum_id is highly
-- selective (a forum belongs to one tenant), so this indexes the sort keys
-- after the leading equality; tenant_id / deleted_at are intentionally left
-- out of the index (they narrow an already-small per-forum set) per the shape
-- #1714 specifies. The existing forum_threads_forum_id_idx covers only the
-- leading filter, not the sort.
--
-- Plain CREATE INDEX (no CONCURRENTLY — forbidden in the multi-statement
-- `supabase db push` pipeline, SQLSTATE 25001).

CREATE INDEX IF NOT EXISTS forum_threads_forum_pinned_created_id_idx
  ON public.forum_threads (forum_id, is_pinned, created_at, id);
