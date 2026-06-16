-- #1165 — Add review_submitted_at to tenants.
-- Used by the sub-host review SLA monitor cron to enforce the 30-day
-- review commitment: alert at day 25, auto-decline at day 30.
-- Backfill with created_at for existing review_submitted rows so the
-- cron has a conservative (never too-late) timestamp to work from.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS review_submitted_at TIMESTAMPTZ;

UPDATE public.tenants
   SET review_submitted_at = created_at
 WHERE onboarding_stage = 'review_submitted'
   AND review_submitted_at IS NULL;
