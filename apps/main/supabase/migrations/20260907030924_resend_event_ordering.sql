-- Migration: resend_event_ordering
-- Version:   20260907030924
-- Generated: 2026-09-07T03:09:24Z by scripts/new-migration.sh
-- Branch:    feature/sweep-resend-ordering-2139
-- Worktree:  atc-sweep-resend-ordering-2139
--
-- #2139 — Resend status webhooks are at-least-once and unordered. Persist the
-- provider occurrence time and event id on email_log, then serialize each
-- transition under a row lock so a stale or lower-precedence status cannot
-- overwrite a newer/terminal observation. Hard-bounce and complaint
-- suppressions are written in the same transaction as status application.
--
-- Expand-only: nullable columns plus a new function. Existing rows remain
-- readable and acquire an ordering watermark on their next accepted event.

ALTER TABLE public.email_log
  ADD COLUMN last_resend_event_at TIMESTAMPTZ,
  ADD COLUMN last_resend_event_id TEXT,
  ADD CONSTRAINT email_log_resend_event_watermark_pair_chk CHECK (
    (last_resend_event_at IS NULL) = (last_resend_event_id IS NULL)
  );

COMMENT ON COLUMN public.email_log.last_resend_event_at IS
  'Provider-created timestamp of the last Resend status event accepted by apply_resend_status_event.';
COMMENT ON COLUMN public.email_log.last_resend_event_id IS
  'Signed Svix event id for the last Resend status event accepted by apply_resend_status_event.';

CREATE OR REPLACE FUNCTION public.apply_resend_status_event(
  p_tenant_id UUID,
  p_email_log_id UUID,
  p_event_id TEXT,
  p_event_created_at TIMESTAMPTZ,
  p_status TEXT,
  p_bounce_reason TEXT
)
RETURNS TABLE (
  outcome TEXT,
  soft_retry_eligible BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_current_status TEXT;
  v_retry_of UUID;
  v_to_email TEXT;
  v_last_event_at TIMESTAMPTZ;
  v_last_event_id TEXT;
  v_current_rank SMALLINT;
  v_incoming_rank SMALLINT;
  v_outcome TEXT;
  v_soft_retry_eligible BOOLEAN := FALSE;
BEGIN
  IF p_event_id IS NULL OR btrim(p_event_id) = '' THEN
    RAISE EXCEPTION 'Resend event id is required';
  END IF;
  IF p_event_created_at IS NULL THEN
    RAISE EXCEPTION 'Resend event created_at is required';
  END IF;

  v_incoming_rank := CASE p_status
    WHEN 'soft_bounced' THEN 1
    WHEN 'delivered' THEN 2
    WHEN 'hard_bounced' THEN 3
    WHEN 'complained' THEN 4
    ELSE NULL
  END;
  IF v_incoming_rank IS NULL THEN
    RAISE EXCEPTION 'Unsupported Resend status: %', p_status;
  END IF;

  SELECT
    target.status,
    target.retry_of,
    target.to_email,
    target.last_resend_event_at,
    target.last_resend_event_id
  INTO
    v_current_status,
    v_retry_of,
    v_to_email,
    v_last_event_at,
    v_last_event_id
  FROM public.email_log AS target
  WHERE target.id = p_email_log_id
    AND target.tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, FALSE;
    RETURN;
  END IF;

  -- A hard bounce or complaint is independently authoritative for list hygiene,
  -- even when its status event is older than the row watermark. DO NOTHING
  -- preserves the first suppression occurrence and makes redelivery idempotent.
  IF p_status IN ('hard_bounced', 'complained') THEN
    INSERT INTO public.email_suppressions (
      tenant_id,
      email_address,
      reason,
      suppressed_at
    ) VALUES (
      p_tenant_id,
      v_to_email,
      CASE p_status
        WHEN 'hard_bounced' THEN 'hard_bounce'
        ELSE 'complaint'
      END,
      p_event_created_at
    )
    ON CONFLICT (tenant_id, email_address, reason) DO NOTHING;
  END IF;

  v_current_rank := CASE v_current_status
    WHEN 'queued' THEN 0
    WHEN 'sent' THEN 0
    WHEN 'soft_bounced' THEN 1
    WHEN 'delivered' THEN 2
    WHEN 'hard_bounced' THEN 3
    WHEN 'complained' THEN 4
    WHEN 'rejected' THEN 4
    WHEN 'suppressed' THEN 4
  END;

  IF v_last_event_id = p_event_id THEN
    v_outcome := 'duplicate';
  ELSIF v_incoming_rank < v_current_rank THEN
    v_outcome := 'stale';
  ELSIF v_last_event_at IS NOT NULL AND p_event_created_at < v_last_event_at THEN
    v_outcome := 'stale';
  ELSIF
    v_last_event_at IS NOT NULL
    AND p_event_created_at = v_last_event_at
    AND v_incoming_rank <= v_current_rank
  THEN
    v_outcome := 'stale';
  ELSE
    UPDATE public.email_log AS target
    SET
      status = p_status,
      last_resend_event_at = p_event_created_at,
      last_resend_event_id = p_event_id,
      delivered_at = CASE
        WHEN p_status = 'delivered' THEN p_event_created_at
        ELSE target.delivered_at
      END,
      bounced_at = CASE
        WHEN p_status IN ('soft_bounced', 'hard_bounced') THEN p_event_created_at
        ELSE target.bounced_at
      END,
      complained_at = CASE
        WHEN p_status = 'complained' THEN p_event_created_at
        ELSE target.complained_at
      END,
      bounce_reason = CASE
        WHEN p_status IN ('soft_bounced', 'hard_bounced') THEN p_bounce_reason
        ELSE target.bounce_reason
      END
    WHERE target.id = p_email_log_id
      AND target.tenant_id = p_tenant_id;
    v_outcome := 'applied';
  END IF;

  -- Exact redelivery remains retry-eligible while the accepted soft status is
  -- still current. This closes the commit-before-Inngest crash window without
  -- allowing a stale soft event to restart a chain after a terminal transition.
  v_soft_retry_eligible :=
    p_status = 'soft_bounced'
    AND v_retry_of IS NULL
    AND (
      v_outcome = 'applied'
      OR (v_outcome = 'duplicate' AND v_current_status = 'soft_bounced')
    );

  RETURN QUERY SELECT v_outcome, v_soft_retry_eligible;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_resend_status_event(UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_resend_status_event(UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT)
  TO service_role;

COMMENT ON FUNCTION public.apply_resend_status_event(UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT) IS
  '#2139: atomically applies ordered, monotonic Resend delivery status events and returns replay-safe soft-retry eligibility.';
