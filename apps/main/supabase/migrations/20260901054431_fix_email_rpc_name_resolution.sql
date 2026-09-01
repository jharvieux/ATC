-- Migration: fix_email_rpc_name_resolution
-- Version:   20260901054431
-- Generated: 2026-09-01T05:44:31Z by scripts/new-migration.sh
-- Branch:    feature/precruise-delivery-hardening
-- Worktree:  atc-precruise-2108
--
-- Qualify expression-level table references in the remaining keyed-email RPCs.
-- Their table return column names are also PL/pgSQL variables, so explicit
-- aliases prevent runtime name-resolution failures without changing behavior.

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
    FROM public.email_log AS retry_target
    WHERE retry_target.id = v_retry_of
      AND retry_target.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'retry_of does not belong to tenant';
  END IF;

  IF v_retry_of IS NULL AND p_retry_content IS NULL THEN
    RAISE EXCEPTION 'retry content is required for an original send';
  END IF;

  INSERT INTO public.email_log AS target (
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
  RETURNING target.id INTO v_log_id;

  v_inserted := v_log_id IS NOT NULL;

  RETURN QUERY
  SELECT
    target.id,
    target.status,
    target.sent_at,
    target.resend_message_id,
    target.provider_idempotency_key,
    target.provider_request_body,
    target.provider_account_type,
    target.provider_credential_hash,
    target.provider_first_attempt_at,
    v_inserted
  FROM public.email_log AS target
  WHERE target.tenant_id = p_tenant_id
    AND target.idempotency_key = p_idempotency_key;
END;
$$;

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
  DELETE FROM public.email_log AS target
  WHERE target.tenant_id = p_tenant_id
    AND target.idempotency_key = p_idempotency_key
    AND target.status = 'queued'
    AND target.sent_at IS NULL
    AND target.provider_first_attempt_at IS NULL
  RETURNING target.id INTO v_deleted;

  RETURN v_deleted IS NOT NULL;
END;
$$;

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
    target.id,
    target.idempotent_effects_recorded_at,
    target.resend_message_id,
    target.retry_of,
    target.retry_content_snapshot
  INTO
    v_log_id,
    v_effects_recorded_at,
    v_existing_resend_message_id,
    v_retry_of,
    v_retry_content
  FROM public.email_log AS target
  WHERE target.tenant_id = p_tenant_id
    AND target.idempotency_key = p_idempotency_key
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

  UPDATE public.email_log AS target
  SET status = CASE
        WHEN target.status IN ('queued', 'rejected') THEN 'sent'
        ELSE target.status
      END,
      sent_at = COALESCE(target.sent_at, v_now),
      resend_message_id = COALESCE(target.resend_message_id, p_resend_message_id)
  WHERE target.id = v_log_id
    AND target.tenant_id = p_tenant_id;

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
      ON CONFLICT ON CONSTRAINT email_retry_content_pkey DO NOTHING;
    END IF;

    INSERT INTO public.tenant_usage_metrics AS metrics (
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
      email_sent_count = metrics.email_sent_count + 1,
      email_sent_today = CASE
        WHEN metrics.email_sent_day_ref = v_today
          THEN metrics.email_sent_today + 1
        ELSE 1
      END,
      email_sent_day_ref = v_today
    RETURNING metrics.email_sent_today INTO v_daily_count;

    UPDATE public.email_log AS target
    SET idempotent_effects_recorded_at = v_now,
        provider_request_body = NULL,
        provider_snapshot_expires_at = NULL,
        retry_content_snapshot = NULL
    WHERE target.id = v_log_id
      AND target.tenant_id = p_tenant_id
      AND target.idempotent_effects_recorded_at IS NULL;
  ELSE
    SELECT CASE
      WHEN metrics.email_sent_day_ref = v_today
        THEN metrics.email_sent_today
      ELSE 0
    END
    INTO v_daily_count
    FROM public.tenant_usage_metrics AS metrics
    WHERE metrics.tenant_id = p_tenant_id
      AND metrics.billing_period = v_period;

    v_daily_count := COALESCE(v_daily_count, 0);
  END IF;

  RETURN QUERY SELECT v_log_id, v_newly_recorded, v_daily_count;
END;
$$;
