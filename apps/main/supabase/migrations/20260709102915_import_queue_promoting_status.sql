-- Migration: import_queue_promoting_status
-- Version:   20260709102915
-- Generated: 2026-07-09T10:29:15Z by scripts/new-migration.sh
-- Branch:    feature/sweep-money-1576
-- Worktree:  agent-aee5a0181f06f4c79
--
-- #1576 — Add an in-flight 'promoting' state to import_queue.status so
-- promoteImport can CAS-claim a row before writing contact/booking/commission.
-- Without a claim, a double-click / two concurrent accepts / an Inngest whole-
-- step retry all re-run the 5-write promote sequence and duplicate the
-- commission → double payout. The claim (pending_review|pending_validation →
-- promoting) lets exactly one execution proceed; losers see zero rows.
--
-- Additive/expand-only: this only widens the CHECK's allowed set. No existing
-- row holds 'promoting', so the drop+recreate validates against current data.
-- No policy, grant, or column changes → no RLS/grants snapshot regen required
-- (docs/runbooks/migrations.md §1). The inline CHECK created with the table
-- (20260616100000) is auto-named import_queue_status_check.
ALTER TABLE public.import_queue DROP CONSTRAINT IF EXISTS import_queue_status_check;
ALTER TABLE public.import_queue ADD CONSTRAINT import_queue_status_check CHECK (status IN (
  'pending_virus_scan',
  'virus_detected',
  'pending_classification',
  'pending_extraction',
  'pending_validation',
  'pending_review',
  'promoting',
  'auto_accepted',
  'accepted',
  'rejected',
  'parse_failed'
));
