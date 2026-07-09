-- Migration: task_reminders_pending_claim_idx_reordered
-- Version:   20260722000016
-- Generated: 2026-07-09T21:29:41Z by scripts/new-migration.sh
-- Branch:    fix/task-reminders-idx-reorder
-- Worktree:  ATC
--
-- REORDER of 20260709112055 (#1679, morning-sweep real-clock version): that
-- version sorts BEFORE 20260722000000_task_reminders_claim_column.sql, which
-- creates the sending_at column this index covers — prod's in-order backlog
-- apply failed with 42703 (operator report, 2026-07-09). Pre-#1717-fix version
-- hazard; the generator now floors above existing versions so this class is
-- closed going forward. Content below is byte-identical to the original.
CREATE INDEX IF NOT EXISTS task_reminders_pending_claim_idx
  ON public.task_reminders(remind_at, sending_at)
  WHERE fired_at IS NULL;
