-- Migration: email_retry_content
-- Version:   20260722000017
-- Generated: 2026-07-12T23:15:03Z by scripts/new-migration.sh
-- Branch:    feature/sweep-email-1611
-- Worktree:  agent-ad0a4dba63922f6c7
--
-- §23.7 soft-bounce retry storage (#1611).
--
-- Operator decision (2026-07-12, option (a)): store the FULLY RENDERED HTML for
-- retry-eligible sends and re-send exactly that on a soft bounce. This reverses
-- the earlier "Option B" (store template ref + variables) which is unimplementable
-- for the ~12 bespoke AI/weather senders whose content isn't reproducible at
-- retry time.
--
-- Two objects:
--   1. email_log.retry_of — marks a send that is itself a §23.7 re-send. The
--      Resend webhook uses it to NOT start a fresh retry chain for re-send rows
--      (the original chain self-drives its +6h/+12h/+24h schedule); sendEmail
--      does NOT store retry content for re-send rows (only the original owns it).
--   2. email_retry_content — one row per retry-eligible original send, holding
--      the rendered payload needed to re-send verbatim, a CAS claim counter, and
--      an expires_at TTL. Rendered HTML is PII, so the table is service-role only
--      and a daily purge cron (email-retry-content-purge) deletes rows past
--      expires_at. TTL is 7 days from send — comfortably covers Resend's
--      soft-bounce-arrival window plus the full 42h+grace retry chain.
--
-- Expand-only: adds a nullable column + a new table. No destructive change.

ALTER TABLE public.email_log
  ADD COLUMN IF NOT EXISTS retry_of UUID REFERENCES public.email_log(id);

CREATE TABLE public.email_retry_content (
  -- The ORIGINAL send this retry payload belongs to. ON DELETE CASCADE so the
  -- payload never outlives its email_log row.
  email_log_id       UUID        PRIMARY KEY REFERENCES public.email_log(id) ON DELETE CASCADE,
  tenant_id          UUID        NOT NULL REFERENCES public.tenants(id),
  -- Rendered payload — enough to reconstruct the sendEmail() call verbatim.
  to_email           TEXT        NOT NULL,
  subject            TEXT        NOT NULL,
  template_id        TEXT        NOT NULL,
  email_category     TEXT        NOT NULL,
  html               TEXT        NOT NULL,
  reply_to           TEXT,
  related_booking_id UUID        REFERENCES public.bookings(id),
  related_group_id   UUID        REFERENCES public.groups(id),
  user_id            UUID        REFERENCES public.users(id),
  contact_id         UUID,
  -- CAS claim (D-091 #21): the retry handler claims attempt N by moving this
  -- from N-1 to N; a duplicate retry event finds it already advanced and skips,
  -- so no attempt double-sends.
  claimed_attempt    INTEGER     NOT NULL DEFAULT 0,
  -- email_log id of the most recent re-send, so the next attempt can read that
  -- row's delivery status before sending again.
  last_send_log_id   UUID        REFERENCES public.email_log(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Purge horizon — the daily cron deletes rows past this (PII retention).
  expires_at         TIMESTAMPTZ NOT NULL
);

-- Purge cron scans by expires_at.
CREATE INDEX email_retry_content_expires_idx
  ON public.email_retry_content(expires_at);

ALTER TABLE public.email_retry_content ENABLE ROW LEVEL SECURITY;

-- Service-role only. Rendered HTML is PII (customer names, booking details);
-- no authenticated read path exists — the retry chain and purge cron (both
-- service-role) are the only consumers. Fail-closed: every role but service_role
-- is denied by policy AND by the absence of a grant.
CREATE POLICY email_retry_content_select_service ON public.email_retry_content
  FOR SELECT USING (FALSE);
CREATE POLICY email_retry_content_insert_service ON public.email_retry_content
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY email_retry_content_update_service ON public.email_retry_content
  FOR UPDATE USING (FALSE);
CREATE POLICY email_retry_content_delete_service ON public.email_retry_content
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_retry_content TO service_role;
-- No grant to authenticated — rendered HTML is PII, service-role only.
