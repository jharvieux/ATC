-- Migration: stripe_webhook_raw_event_nullable
-- Version:   20260709111840
-- Generated: 2026-07-09T11:18:40Z by scripts/new-migration.sh
-- Branch:    feature/sweep-dataops-1590
-- Worktree:  agent-a03ee592736c75798
--
-- #1590 — allow stripe_webhook_events.raw_event to be NULLed on a retention
-- schedule. The dedup row (stripe_event_id) must survive forever so replayed
-- events stay recognisable as duplicates, but raw_event holds the full Stripe
-- payload (customer PII) and is never read after processing. The
-- data-retention-purge cron nulls it past its window; that requires dropping
-- the NOT NULL constraint. No app code reads raw_event (only the webhook
-- handler writes it on insert), so loosening the constraint is safe.

ALTER TABLE public.stripe_webhook_events
  ALTER COLUMN raw_event DROP NOT NULL;
