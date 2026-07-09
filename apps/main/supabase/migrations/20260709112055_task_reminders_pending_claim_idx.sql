-- Migration: task_reminders_pending_claim_idx
-- Version:   20260709112055
-- Generated: 2026-07-09T11:20:55Z by scripts/new-migration.sh
-- Branch:    feature/sweep-dataops-1590
-- Worktree:  agent-a03ee592736c75798
--
-- #1679 — covering index for the task-reminders-fire claim scan.
-- The claim/select query filters `fired_at IS NULL` AND `remind_at <= now`
-- AND `(sending_at IS NULL OR sending_at < staleCutoff)`. The existing partial
-- index task_reminders_pending_idx(remind_at) WHERE fired_at IS NULL covers the
-- first two predicates but not the sending_at claim predicate, leaving a filter
-- step on every candidate row. Extending the partial index to (remind_at,
-- sending_at) lets the planner satisfy the remind_at range and the sending_at
-- claim check from the index alone. Plain CREATE INDEX IF NOT EXISTS (no
-- CONCURRENTLY — single-statement rule per docs/runbooks/migrations.md §3; the
-- brief lock on this low-volume table is negligible).

CREATE INDEX IF NOT EXISTS task_reminders_pending_claim_idx
  ON public.task_reminders(remind_at, sending_at)
  WHERE fired_at IS NULL;
