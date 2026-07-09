-- Migration: quotes_tenant_created_id_idx
-- Version:   20260722000010
-- Generated: 2026-07-09 by scripts/new-migration.sh
-- Branch:    feature/sweep-db-misc-1698
-- Worktree:  agent-a79f0cb75f2288c77
--
-- #1714 (#1588/#1701 follow-up) — covering composite index for the quotes list
-- route. The route is tenant-scoped, orders `created_at` DESC then `id` ASC as
-- a page-stable tiebreaker for its `.range()` pagination. The existing
-- quotes_tenant_status_idx (tenant_id, status) and quotes_contact_idx don't
-- cover this filter+sort. This index matches the (filter, order, tiebreaker)
-- shape so the paged sort is index-covered.
--
-- Plain CREATE INDEX (no CONCURRENTLY — forbidden in the multi-statement
-- `supabase db push` pipeline, SQLSTATE 25001).

CREATE INDEX IF NOT EXISTS quotes_tenant_created_id_idx
  ON public.quotes (tenant_id, created_at, id);
