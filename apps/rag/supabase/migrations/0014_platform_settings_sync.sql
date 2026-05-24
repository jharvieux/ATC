-- D-041 follow-up — Cross-project sync for platform_settings, rag side.
--
-- The rag-side platform_settings table was created in migration 0006 as a
-- manually-seeded replica. This migration adds the bookkeeping columns the
-- webhook receiver + nightly reconcile cron need:
--
--   • source_revision  — monotonic integer from main's EXTRACT(EPOCH FROM
--                        updated_at). Receiver compares to short-circuit
--                        stale-event reordering.
--   • last_webhook_sync_at    — observability for the webhook path.
--   • last_reconcile_sync_at  — observability for the nightly drift sweep.
--
-- Defaults are chosen so existing manually-seeded rows don't trip the
-- stale-event guard the first time a webhook arrives (source_revision=0
-- → any real event has a higher revision and wins).

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS source_revision        INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_webhook_sync_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reconcile_sync_at TIMESTAMPTZ;
