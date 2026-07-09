-- Migration: bookings_review_reason_host_state_unknown
-- Version:   20260709101904
-- Generated: 2026-07-09T10:19:04Z by scripts/new-migration.sh
-- Branch:    feature/sweep-payouts-1577
-- Worktree:  agent-a8767b59da2a818c8
--
-- #1577 — booking submit is a money-path state machine. Two new terminal
-- review reasons are needed so a stuck/failed submit is never silently reverted
-- to a re-submittable 'draft' (which would risk a SECOND live cruise-line
-- booking):
--
--   'host_state_unknown'     — the stuck-submitting reconcile cron can no longer
--                              tell "crashed before the host call" from "host
--                              call succeeded, ref not yet persisted", so it
--                              routes stuck rows here for manual/adapter
--                              reconciliation instead of back to 'draft'.
--   'commission_write_failed'— the host booking succeeded and provider_booking_ref
--                              is persisted, but the commissions insert failed;
--                              the booking must be reviewed (host state is real)
--                              rather than reverted.
--
-- CHECK-constraint change only — no policy, no grant, no column drop, so no
-- RLS/grants snapshot regen is required (check:policy-snapshot scopes to
-- CREATE/ALTER/DROP POLICY; grants:check sees no GRANT here). Additive to the
-- allowed set — existing rows all carry the prior values, so the re-add is safe.

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_review_reason_check;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_review_reason_check
    CHECK (review_reason IN (
      'commission_rate_unresolvable',
      'missing_platform_split',
      'host_adapter_unhealthy',
      'manual_review_requested',
      'host_state_unknown',
      'commission_write_failed'
    ));
