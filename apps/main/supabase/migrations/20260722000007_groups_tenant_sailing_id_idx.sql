-- Migration: groups_tenant_sailing_id_idx
-- Version:   20260722000007
-- Generated: 2026-07-09 by scripts/new-migration.sh
-- Branch:    feature/sweep-db-misc-1698
-- Worktree:  agent-a79f0cb75f2288c77
--
-- #1714 (#1588/#1701 follow-up) — covering composite index for the groups
-- list route. The route filters `tenant_id`, orders `sailing_date` ASC, then
-- `id` ASC as a page-stable tiebreaker for its `.range()` pagination. The
-- existing single-column groups_sailing_idx / groups_tenant_idx don't cover
-- the combined filter+sort, so paged reads sort in memory. This index matches
-- the exact (filter, order, tiebreaker) shape so the sort is index-covered.
--
-- Plain CREATE INDEX (no CONCURRENTLY — forbidden in the multi-statement
-- `supabase db push` pipeline, SQLSTATE 25001; the lock is negligible here).

CREATE INDEX IF NOT EXISTS groups_tenant_sailing_id_idx
  ON public.groups (tenant_id, sailing_date, id);
