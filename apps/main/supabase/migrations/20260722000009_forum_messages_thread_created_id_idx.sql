-- Migration: forum_messages_thread_created_id_idx
-- Version:   20260722000009
-- Generated: 2026-07-09 by scripts/new-migration.sh
-- Branch:    feature/sweep-db-misc-1698
-- Worktree:  agent-a79f0cb75f2288c77
--
-- #1714 (#1588/#1701 follow-up) — extend the forum messages covering index to
-- include the `.range()` pagination tiebreaker. The route filters `thread_id`
-- (+ forum_id + tenant_id, + status for non-coordinators) and orders
-- `created_at` DESC then `id` ASC. The existing
-- forum_messages_thread_created_idx (thread_id, created_at) covers the primary
-- sort but not the id tiebreaker, so the last sort step falls back to memory.
-- The new (thread_id, created_at, id) index fully supersedes the 2-column one
-- (that index's key is a strict prefix of this one), so we drop the old index
-- in the same statement group to avoid a redundant write-amplifying duplicate.
-- Dropping a superseded index is non-destructive to data — no expand→contract
-- split is needed (that rule is for column/read switchovers).
--
-- Plain CREATE INDEX (no CONCURRENTLY — forbidden in the multi-statement
-- `supabase db push` pipeline, SQLSTATE 25001).

CREATE INDEX IF NOT EXISTS forum_messages_thread_created_id_idx
  ON public.forum_messages (thread_id, created_at, id);

DROP INDEX IF EXISTS public.forum_messages_thread_created_idx;
