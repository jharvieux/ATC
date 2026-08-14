-- Migration: help_sessions_started_at_idx
-- Version:   20260814034826
-- Generated: 2026-08-14T03:48:26Z by scripts/new-migration.sh
-- Branch:    feature/sweep-retention-2037
-- Worktree:  atc-sweep-retention-2037
--
-- Supports data-retention-purge's global 365-day orphan candidate scan. The
-- existing help_sessions indexes are tenant-prefixed and cannot serve its
-- started_at range predicate. Re-runnable; rollback is DROP INDEX.

CREATE INDEX IF NOT EXISTS help_sessions_started_at_idx
  ON public.help_sessions (started_at);
