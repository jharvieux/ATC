-- Migration: stripe_webhook_stale_discarded_outcome
-- Version:   20260709111844
-- Generated: 2026-07-09T11:18:44Z by scripts/new-migration.sh
-- Branch:    feature/sweep-dataops-1590
-- Worktree:  agent-a03ee592736c75798
--
-- #1677 — widen stripe_webhook_events.processing_outcome CHECK to add
-- 'stale_discarded'. The subscription-ordering fix (#1583 / PR #1642) records
-- events discarded as out-of-order-stale with outcome='unhandled' — the SAME
-- value used when the handler has no branch for an event type at all. A
-- dashboard over processing_outcome then can't tell "we have no handler (a real
-- gap needing code)" from "we handled it and correctly discarded a stale
-- duplicate (healthy)". A distinct value restores that observability.
--
-- Purely additive: the inline constraint from 20260521170000 is auto-named
-- stripe_webhook_events_processing_outcome_check.

ALTER TABLE public.stripe_webhook_events
  DROP CONSTRAINT IF EXISTS stripe_webhook_events_processing_outcome_check;

ALTER TABLE public.stripe_webhook_events
  ADD CONSTRAINT stripe_webhook_events_processing_outcome_check
  CHECK (processing_outcome IN ('success','duplicate','error','unhandled','stale_discarded'));
