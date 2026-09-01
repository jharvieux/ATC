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
  ADD COLUMN send_claimed_at TIMESTAMPTZ;

ALTER TABLE public.email_log
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN idempotent_effects_recorded_at TIMESTAMPTZ,
  ADD COLUMN provider_idempotency_key TEXT,
  ADD COLUMN provider_request_body TEXT,
  ADD COLUMN provider_account_type TEXT,
  ADD COLUMN provider_credential_hash TEXT,
  ADD COLUMN provider_first_attempt_at TIMESTAMPTZ,
  ADD COLUMN provider_snapshot_expires_at TIMESTAMPTZ,
  ADD COLUMN retry_content_snapshot JSONB,
  ADD CONSTRAINT email_log_provider_idempotency_key_length_chk CHECK (
    provider_idempotency_key IS NULL
    OR char_length(provider_idempotency_key) BETWEEN 1 AND 256
  ),
  ADD CONSTRAINT email_log_provider_account_type_chk CHECK (
    provider_account_type IS NULL
    OR provider_account_type IN ('platform_resend', 'tenant_resend')
  ),
  ADD CONSTRAINT email_log_provider_credential_hash_chk CHECK (
    provider_credential_hash IS NULL
    OR provider_credential_hash ~ '^[0-9a-f]{64}$'
  );

CREATE UNIQUE INDEX email_log_tenant_idempotency_key_uidx
  ON public.email_log(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- A queued row is an outbox snapshot, not evidence of a completed send. Its
-- exact provider body/key remain immutable across retries; the first caller to
-- insert a tenant/logical key owns the authoritative provider variant.
CREATE OR REPLACE FUNCTION public.prepare_idempotent_email_send(
  p_tenant_id UUID,
  p_idempotency_key TEXT,
  p_provider_idempotency_key TEXT,
  p_provider_request_body TEXT,
  p_provider_account_type TEXT,
  p_provider_credential_hash TEXT,
  p_log JSONB,
  p_retry_content JSONB DEFAULT NULL
)
RETURNS TABLE (
  email_log_id UUID,
  email_status TEXT,
  sent_at TIMESTAMPTZ,
  resend_message_id TEXT,
  provider_idempotency_key TEXT,
  provider_request_body TEXT,
  provider_account_type TEXT,
  provider_credential_hash TEXT,
  provider_first_attempt_at TIMESTAMPTZ,
  newly_queued BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_log_id UUID;
  v_inserted BOOLEAN := FALSE;
  v_retry_of UUID := NULLIF(p_log->>'retry_of', '')::UUID;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'idempotency key is required';
  END IF;

  IF
    p_provider_idempotency_key IS NULL
    OR btrim(p_provider_idempotency_key) = ''
    OR char_length(p_provider_idempotency_key) > 256
  THEN
    RAISE EXCEPTION 'provider idempotency key must contain 1-256 characters';
  END IF;

  IF p_provider_request_body IS NULL OR p_provider_request_body = '' THEN
    RAISE EXCEPTION 'provider request body is required';
  END IF;

  IF p_provider_account_type NOT IN ('platform_resend', 'tenant_resend') THEN
    RAISE EXCEPTION 'provider account type is invalid';
  END IF;

  IF p_provider_credential_hash IS NULL OR p_provider_credential_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'provider credential hash is invalid';
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
    idempotency_key,
    provider_idempotency_key,
    provider_request_body,
    provider_account_type,
    provider_credential_hash,
    provider_snapshot_expires_at,
    retry_content_snapshot
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
    'queued',
    NULL,
    p_log->>'email_category',
    NULLIF(p_log->>'related_booking_id', '')::UUID,
    NULLIF(p_log->>'related_group_id', '')::UUID,
    v_retry_of,
    p_idempotency_key,
    p_provider_idempotency_key,
    p_provider_request_body,
    p_provider_account_type,
    p_provider_credential_hash,
    v_now + INTERVAL '7 days',
    p_retry_content
  )
  ON CONFLICT (tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_log_id;

  v_inserted := v_log_id IS NOT NULL;

  RETURN QUERY
  SELECT
    email_log.id,
    email_log.status,
    email_log.sent_at,
    email_log.resend_message_id,
    email_log.provider_idempotency_key,
    email_log.provider_request_body,
    email_log.provider_account_type,
    email_log.provider_credential_hash,
    email_log.provider_first_attempt_at,
    v_inserted
  FROM public.email_log
  WHERE email_log.tenant_id = p_tenant_id
    AND email_log.idempotency_key = p_idempotency_key;
END;
$$;

-- The attempt epoch is stamped only after the caller's last policy check and
-- immediately before dispatch. Once set, the exact outbox request may replay
-- for 23 hours; after that the function fails closed before another provider
-- call can escape Resend's 24-hour deduplication window.
CREATE OR REPLACE FUNCTION public.start_idempotent_email_dispatch(
  p_tenant_id UUID,
  p_idempotency_key TEXT
)
RETURNS TABLE (
  email_log_id UUID,
  provider_idempotency_key TEXT,
  provider_request_body TEXT,
  provider_account_type TEXT,
  provider_credential_hash TEXT,
  provider_first_attempt_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_log_id UUID;
  v_provider_key TEXT;
  v_provider_body TEXT;
  v_provider_account_type TEXT;
  v_provider_credential_hash TEXT;
  v_first_attempt_at TIMESTAMPTZ;
  v_snapshot_expires_at TIMESTAMPTZ;
BEGIN
  SELECT
    id,
    email_log.provider_idempotency_key,
    email_log.provider_request_body,
    email_log.provider_account_type,
    email_log.provider_credential_hash,
    email_log.provider_first_attempt_at,
    provider_snapshot_expires_at
  INTO
    v_log_id,
    v_provider_key,
    v_provider_body,
    v_provider_account_type,
    v_provider_credential_hash,
    v_first_attempt_at,
    v_snapshot_expires_at
  FROM public.email_log
  WHERE tenant_id = p_tenant_id
    AND idempotency_key = p_idempotency_key
    AND status = 'queued'
    AND sent_at IS NULL
  FOR UPDATE;

  IF v_log_id IS NULL OR v_provider_key IS NULL OR v_provider_body IS NULL THEN
    RAISE EXCEPTION 'queued provider snapshot not found';
  END IF;

  IF v_snapshot_expires_at IS NULL OR v_snapshot_expires_at <= v_now THEN
    RAISE EXCEPTION 'queued provider snapshot expired';
  END IF;

  IF v_first_attempt_at IS NOT NULL AND v_now - v_first_attempt_at >= INTERVAL '23 hours' THEN
    RAISE EXCEPTION 'provider replay window expired';
  END IF;

  IF v_first_attempt_at IS NULL THEN
    v_first_attempt_at := v_now;
    UPDATE public.email_log
    SET provider_first_attempt_at = v_first_attempt_at
    WHERE id = v_log_id
      AND tenant_id = p_tenant_id
      AND provider_first_attempt_at IS NULL;
  END IF;

  RETURN QUERY SELECT
    v_log_id,
    v_provider_key,
    v_provider_body,
    v_provider_account_type,
    v_provider_credential_hash,
    v_first_attempt_at;
END;
$$;

-- A policy rejection can discard only a queued snapshot that has never crossed
-- the provider-attempt boundary. Started/ambiguous rows are immutable.
CREATE OR REPLACE FUNCTION public.abandon_unstarted_idempotent_email(
  p_tenant_id UUID,
  p_idempotency_key TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted UUID;
BEGIN
  DELETE FROM public.email_log
  WHERE tenant_id = p_tenant_id
    AND idempotency_key = p_idempotency_key
    AND status = 'queued'
    AND sent_at IS NULL
    AND provider_first_attempt_at IS NULL
  RETURNING id INTO v_deleted;

  RETURN v_deleted IS NOT NULL;
END;
$$;

-- collectively-atomic-writes: after provider success, one transaction marks
-- the queued log sent, creates the original retry payload, and accounts for the
-- send exactly once. Replays also return the current UTC-day count so the
-- caller can heal a state-transition crash.
CREATE OR REPLACE FUNCTION public.finalize_idempotent_email_send(
  p_tenant_id UUID,
  p_idempotency_key TEXT,
  p_resend_message_id TEXT
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
  v_now TIMESTAMPTZ := clock_timestamp();
  v_log_id UUID;
  v_effects_recorded_at TIMESTAMPTZ;
  v_existing_resend_message_id TEXT;
  v_retry_of UUID;
  v_retry_content JSONB;
  v_today DATE := (v_now AT TIME ZONE 'UTC')::DATE;
  v_period DATERANGE := daterange(
    date_trunc('month', v_now AT TIME ZONE 'UTC')::DATE,
    (date_trunc('month', v_now AT TIME ZONE 'UTC') + INTERVAL '1 month')::DATE,
    '[)'
  );
  v_daily_count INTEGER;
  v_newly_recorded BOOLEAN;
BEGIN
  SELECT
    id,
    idempotent_effects_recorded_at,
    resend_message_id,
    retry_of,
    retry_content_snapshot
  INTO
    v_log_id,
    v_effects_recorded_at,
    v_existing_resend_message_id,
    v_retry_of,
    v_retry_content
  FROM public.email_log
  WHERE tenant_id = p_tenant_id
    AND idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF v_log_id IS NULL THEN
    RAISE EXCEPTION 'idempotent email outbox not found';
  END IF;

  IF
    v_existing_resend_message_id IS NULL
    AND (p_resend_message_id IS NULL OR btrim(p_resend_message_id) = '')
  THEN
    RAISE EXCEPTION 'provider message id is required';
  END IF;

  IF
    v_existing_resend_message_id IS NOT NULL
    AND p_resend_message_id IS NOT NULL
    AND v_existing_resend_message_id <> p_resend_message_id
  THEN
    RAISE EXCEPTION 'idempotency key provider response mismatch';
  END IF;

  v_newly_recorded := v_effects_recorded_at IS NULL;

  UPDATE public.email_log
  SET status = CASE
        WHEN status IN ('queued', 'rejected') THEN 'sent'
        ELSE status
      END,
      sent_at = COALESCE(sent_at, v_now),
      resend_message_id = COALESCE(resend_message_id, p_resend_message_id)
  WHERE id = v_log_id
    AND tenant_id = p_tenant_id;

  IF v_effects_recorded_at IS NULL THEN
    IF v_retry_of IS NULL THEN
      IF v_retry_content IS NULL THEN
        RAISE EXCEPTION 'retry content snapshot is required for an original send';
      END IF;

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
        v_retry_content->>'to_email',
        v_retry_content->>'subject',
        v_retry_content->>'template_id',
        v_retry_content->>'email_category',
        v_retry_content->>'html',
        NULLIF(v_retry_content->>'reply_to', ''),
        NULLIF(v_retry_content->>'related_booking_id', '')::UUID,
        NULLIF(v_retry_content->>'related_group_id', '')::UUID,
        NULLIF(v_retry_content->>'user_id', '')::UUID,
        NULLIF(v_retry_content->>'contact_id', '')::UUID,
        (v_retry_content->>'expires_at')::TIMESTAMPTZ
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
    SET idempotent_effects_recorded_at = v_now,
        provider_request_body = NULL,
        provider_snapshot_expires_at = NULL,
        retry_content_snapshot = NULL
    WHERE id = v_log_id
      AND tenant_id = p_tenant_id
      AND idempotent_effects_recorded_at IS NULL;
  ELSE
    SELECT CASE
      WHEN public.tenant_usage_metrics.email_sent_day_ref = v_today
        THEN public.tenant_usage_metrics.email_sent_today
      ELSE 0
    END
    INTO v_daily_count
    FROM public.tenant_usage_metrics
    WHERE tenant_id = p_tenant_id
      AND billing_period = v_period;

    v_daily_count := COALESCE(v_daily_count, 0);
  END IF;

  RETURN QUERY SELECT v_log_id, v_newly_recorded, v_daily_count;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_idempotent_email_send(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_idempotent_email_send(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB)
  TO service_role;

REVOKE ALL ON FUNCTION public.start_idempotent_email_dispatch(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_idempotent_email_dispatch(UUID, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION public.abandon_unstarted_idempotent_email(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abandon_unstarted_idempotent_email(UUID, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION public.finalize_idempotent_email_send(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_idempotent_email_send(UUID, TEXT, TEXT)
  TO service_role;
