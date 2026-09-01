-- Migration: precruise_send_claim
-- Version:   20260831210837
-- Generated: 2026-08-31T21:08:37Z by scripts/new-migration.sh
-- Branch:    feature/precruise-delivery-hardening
-- Worktree:  atc-precruise-2108
--
-- Record the material booking/contact context used to generate unsent cached
-- content, prevent parallel consumers from both invoking the shared email
-- sender, and make the post-provider log/retry/accounting effects collectively
-- atomic and replay-safe.

ALTER TABLE public.pre_cruise_email_content
  ADD COLUMN content_context_hash TEXT,
  ADD COLUMN send_claimed_at TIMESTAMPTZ,
  ADD COLUMN provider_first_attempt_at TIMESTAMPTZ;

ALTER TABLE public.email_log
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN idempotent_effects_recorded_at TIMESTAMPTZ;

CREATE UNIQUE INDEX email_log_tenant_idempotency_key_uidx
  ON public.email_log(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- collectively-atomic-writes: one successful provider delivery owns exactly
-- one logical log, one retry payload, and one usage increment. The effects
-- timestamp also lets a replay heal an orphaned logical log without counting
-- it twice.
CREATE OR REPLACE FUNCTION public.finalize_idempotent_email_send(
  p_tenant_id UUID,
  p_idempotency_key TEXT,
  p_log JSONB,
  p_retry_content JSONB DEFAULT NULL
)
RETURNS TABLE (
  email_log_id UUID,
  newly_recorded BOOLEAN,
  email_sent_today INTEGER
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_log_id UUID;
  v_inserted BOOLEAN := FALSE;
  v_effects_recorded_at TIMESTAMPTZ;
  v_existing_resend_message_id TEXT;
  v_retry_of UUID := NULLIF(p_log->>'retry_of', '')::UUID;
  v_today DATE := (clock_timestamp() AT TIME ZONE 'UTC')::DATE;
  v_period DATERANGE := daterange(
    date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::DATE,
    (date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '1 month')::DATE,
    '[)'
  );
  v_daily_count INTEGER;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'idempotency key is required';
  END IF;

  IF v_retry_of IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.email_log
    WHERE id = v_retry_of
      AND tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'retry_of does not belong to tenant';
  END IF;

  IF v_retry_of IS NULL AND p_retry_content IS NULL THEN
    RAISE EXCEPTION 'retry content is required for an original send';
  END IF;

  INSERT INTO public.email_log (
    tenant_id,
    user_id,
    contact_id,
    to_email,
    from_email,
    reply_to,
    subject,
    template_id,
    template_version,
    template_variables,
    status,
    sent_at,
    email_category,
    related_booking_id,
    related_group_id,
    retry_of,
    idempotency_key
  ) VALUES (
    p_tenant_id,
    NULLIF(p_log->>'user_id', '')::UUID,
    NULLIF(p_log->>'contact_id', '')::UUID,
    p_log->>'to_email',
    p_log->>'from_email',
    NULLIF(p_log->>'reply_to', ''),
    p_log->>'subject',
    p_log->>'template_id',
    NULLIF(p_log->>'template_version', '')::INTEGER,
    NULLIF(p_log->'template_variables', 'null'::JSONB),
    'sent',
    COALESCE(NULLIF(p_log->>'sent_at', '')::TIMESTAMPTZ, clock_timestamp()),
    p_log->>'email_category',
    NULLIF(p_log->>'related_booking_id', '')::UUID,
    NULLIF(p_log->>'related_group_id', '')::UUID,
    v_retry_of,
    p_idempotency_key
  )
  ON CONFLICT (tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_log_id;

  v_inserted := v_log_id IS NOT NULL;

  SELECT
    id,
    idempotent_effects_recorded_at,
    resend_message_id
  INTO
    v_log_id,
    v_effects_recorded_at,
    v_existing_resend_message_id
  FROM public.email_log
  WHERE tenant_id = p_tenant_id
    AND idempotency_key = p_idempotency_key
    AND to_email = p_log->>'to_email'
    AND from_email = p_log->>'from_email'
    AND subject = p_log->>'subject'
    AND template_id = p_log->>'template_id'
    AND email_category IS NOT DISTINCT FROM p_log->>'email_category'
    AND retry_of IS NOT DISTINCT FROM v_retry_of
  FOR UPDATE;

  IF v_log_id IS NULL THEN
    RAISE EXCEPTION 'idempotency key payload mismatch';
  END IF;

  IF
    v_existing_resend_message_id IS NOT NULL
    AND NULLIF(p_log->>'resend_message_id', '') IS NOT NULL
    AND v_existing_resend_message_id <> p_log->>'resend_message_id'
  THEN
    RAISE EXCEPTION 'idempotency key provider response mismatch';
  END IF;

  UPDATE public.email_log
  SET status = CASE
        WHEN status IN ('queued', 'rejected') THEN 'sent'
        ELSE status
      END,
      sent_at = COALESCE(
        sent_at,
        NULLIF(p_log->>'sent_at', '')::TIMESTAMPTZ,
        clock_timestamp()
      ),
      resend_message_id = COALESCE(
        resend_message_id,
        NULLIF(p_log->>'resend_message_id', '')
      )
  WHERE id = v_log_id
    AND tenant_id = p_tenant_id;

  IF v_effects_recorded_at IS NULL THEN
    IF v_retry_of IS NULL THEN
      INSERT INTO public.email_retry_content (
        email_log_id,
        tenant_id,
        to_email,
        subject,
        template_id,
        email_category,
        html,
        reply_to,
        related_booking_id,
        related_group_id,
        user_id,
        contact_id,
        expires_at
      ) VALUES (
        v_log_id,
        p_tenant_id,
        p_retry_content->>'to_email',
        p_retry_content->>'subject',
        p_retry_content->>'template_id',
        p_retry_content->>'email_category',
        p_retry_content->>'html',
        NULLIF(p_retry_content->>'reply_to', ''),
        NULLIF(p_retry_content->>'related_booking_id', '')::UUID,
        NULLIF(p_retry_content->>'related_group_id', '')::UUID,
        NULLIF(p_retry_content->>'user_id', '')::UUID,
        NULLIF(p_retry_content->>'contact_id', '')::UUID,
        (p_retry_content->>'expires_at')::TIMESTAMPTZ
      )
      ON CONFLICT (email_log_id) DO NOTHING;
    END IF;

    INSERT INTO public.tenant_usage_metrics (
      tenant_id,
      billing_period,
      email_sent_count,
      email_sent_today,
      email_sent_day_ref
    ) VALUES (
      p_tenant_id,
      v_period,
      1,
      1,
      v_today
    )
    ON CONFLICT (tenant_id, billing_period)
    DO UPDATE SET
      email_sent_count = public.tenant_usage_metrics.email_sent_count + 1,
      email_sent_today = CASE
        WHEN public.tenant_usage_metrics.email_sent_day_ref = v_today
          THEN public.tenant_usage_metrics.email_sent_today + 1
        ELSE 1
      END,
      email_sent_day_ref = v_today
    RETURNING public.tenant_usage_metrics.email_sent_today INTO v_daily_count;

    UPDATE public.email_log
    SET idempotent_effects_recorded_at = clock_timestamp()
    WHERE id = v_log_id
      AND tenant_id = p_tenant_id
      AND idempotent_effects_recorded_at IS NULL;
  ELSE
    SELECT CASE
      WHEN email_sent_day_ref = v_today THEN email_sent_today
      ELSE 0
    END
    INTO v_daily_count
    FROM public.tenant_usage_metrics
    WHERE tenant_id = p_tenant_id
      AND billing_period = v_period;

    v_daily_count := COALESCE(v_daily_count, 0);
  END IF;

  RETURN QUERY SELECT v_log_id, v_inserted, v_daily_count;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_idempotent_email_send(UUID, TEXT, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_idempotent_email_send(UUID, TEXT, JSONB, JSONB)
  TO service_role;
