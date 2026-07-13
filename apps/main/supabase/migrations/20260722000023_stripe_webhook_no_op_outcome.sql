-- Migration: stripe_webhook_no_op_outcome
-- Version:   20260722000023
-- Generated: 2026-07-13T13:56:00Z by scripts/new-migration.sh
-- Branch:    feature/sweep-billing-1873
-- Worktree:  agent-ad4f029ec8b9a0525
--
-- #1873 — widen stripe_webhook_events.processing_outcome CHECK to add 'no_op'.
-- The transfer.reversed handler records outcome='unhandled' when
-- process_transfer_reversal returns 0 rows — but a 0-row reversal is a healthy
-- no-op (the transfer isn't ours, or this exact (transfer, event) was already
-- applied), NOT the coverage-gap that 'unhandled' is reserved for (an event
-- type with no handler branch at all). Conflating the two poisons any dashboard
-- over processing_outcome. Same class as #1677/#1854's 'stale_discarded'; a
-- distinct value restores observability.
--
-- Purely additive: the inline constraint from 20260521170000 (widened by
-- 20260709111844 to add 'stale_discarded') is auto-named
-- stripe_webhook_events_processing_outcome_check. Idempotent re-apply
-- (DROP ... IF EXISTS then re-ADD). No reader breaks; not a policy/grant change,
-- so no snapshot regen.

ALTER TABLE public.stripe_webhook_events
  DROP CONSTRAINT IF EXISTS stripe_webhook_events_processing_outcome_check;

ALTER TABLE public.stripe_webhook_events
  ADD CONSTRAINT stripe_webhook_events_processing_outcome_check
  CHECK (processing_outcome IN ('success','duplicate','error','unhandled','stale_discarded','no_op'));
