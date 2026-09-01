-- Migration: isolate_email_provider_dispatch
-- Version:   20260901063425
-- Generated: 2026-09-01T06:34:25Z by scripts/new-migration.sh
-- Branch:    feature/precruise-delivery-hardening
-- Worktree:  atc-precruise-2108
--
-- Move the exact provider request and retry-content snapshot out of email_log,
-- which authenticated tenant users may read, into a service-role-only outbox.
-- The outbox also distinguishes an unstarted request, an ambiguous provider
-- attempt, and a definitive provider rejection so only genuinely ambiguous
-- attempts bypass mutable pre-send policy checks on replay.
--
-- Expand/read-switchover only: the legacy email_log provider columns remain
-- nullable for rolling-deploy compatibility. A later contract migration may
-- drop them after every deployed reader has switched to this table.

CREATE UNIQUE INDEX email_log_id_tenant_id_uidx
  ON public.email_log(id, tenant_id);

CREATE TABLE public.email_provider_dispatch (
  email_log_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  provider_idempotency_key TEXT NOT NULL CHECK (
    char_length(provider_idempotency_key) BETWEEN 1 AND 256
  ),
  provider_request_body TEXT,
  provider_account_type TEXT NOT NULL CHECK (
    provider_account_type IN ('platform_resend', 'tenant_resend')
  ),
  provider_credential_hash TEXT NOT NULL CHECK (
    provider_credential_hash ~ '^[0-9a-f]{64}$'
  ),
  provider_first_attempt_at TIMESTAMPTZ,
  provider_attempt_state TEXT NOT NULL DEFAULT 'unstarted' CHECK (
    provider_attempt_state IN ('unstarted', 'ambiguous', 'rejected')
  ),
  provider_snapshot_expires_at TIMESTAMPTZ,
  retry_content_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT email_provider_dispatch_log_tenant_fk
    FOREIGN KEY (email_log_id, tenant_id)
    REFERENCES public.email_log(id, tenant_id)
    ON DELETE CASCADE
);

CREATE INDEX email_provider_dispatch_expiry_idx
  ON public.email_provider_dispatch(provider_snapshot_expires_at)
  WHERE provider_request_body IS NOT NULL;

COMMENT ON TABLE public.email_provider_dispatch IS
  'Service-role-only transient provider outbox. Exact rendered request and retry snapshot become purge-eligible when the 23-hour provider replay window closes.';
COMMENT ON COLUMN public.email_provider_dispatch.provider_request_body IS
  'Exact serialized Resend request body; customer PII; cleared on finalization or by the bounded hourly purge after the 23-hour replay window.';
COMMENT ON COLUMN public.email_provider_dispatch.retry_content_snapshot IS
  'Rendered retry payload; customer PII; moved to email_retry_content on successful finalization.';

ALTER TABLE public.email_provider_dispatch ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_provider_dispatch_select_service
  ON public.email_provider_dispatch FOR SELECT USING (FALSE);
CREATE POLICY email_provider_dispatch_insert_service
  ON public.email_provider_dispatch FOR INSERT WITH CHECK (FALSE);
CREATE POLICY email_provider_dispatch_update_service
  ON public.email_provider_dispatch FOR UPDATE USING (FALSE);
CREATE POLICY email_provider_dispatch_delete_service
  ON public.email_provider_dispatch FOR DELETE USING (FALSE);

REVOKE ALL ON TABLE public.email_provider_dispatch FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_provider_dispatch TO service_role;

-- Backfill any queued/sent rows created by the earlier implementation before
-- removing their provider-private fields from the authenticated-readable log.
INSERT INTO public.email_provider_dispatch (
  email_log_id,
  tenant_id,
  provider_idempotency_key,
  provider_request_body,
  provider_account_type,
  provider_credential_hash,
  provider_first_attempt_at,
  provider_attempt_state,
  provider_snapshot_expires_at,
  retry_content_snapshot,
  created_at
)
SELECT
  log.id,
  log.tenant_id,
  log.provider_idempotency_key,
  log.provider_request_body,
  log.provider_account_type,
  log.provider_credential_hash,
  log.provider_first_attempt_at,
  CASE
    WHEN log.provider_first_attempt_at IS NULL THEN 'unstarted'
    ELSE 'ambiguous'
  END,
  CASE
    WHEN log.provider_request_body IS NULL THEN NULL
    ELSE LEAST(
      COALESCE(
        log.provider_snapshot_expires_at,
        COALESCE(log.provider_first_attempt_at, log.created_at, clock_timestamp()) + INTERVAL '23 hours'
      ),
      COALESCE(log.provider_first_attempt_at, log.created_at, clock_timestamp()) + INTERVAL '23 hours'
    )
  END,
  log.retry_content_snapshot,
  COALESCE(log.created_at, clock_timestamp())
FROM public.email_log AS log
WHERE log.idempotency_key IS NOT NULL
  AND log.provider_idempotency_key IS NOT NULL
  AND log.provider_account_type IS NOT NULL
  AND log.provider_credential_hash IS NOT NULL
ON CONFLICT (email_log_id) DO NOTHING;

UPDATE public.email_log AS log
SET provider_idempotency_key = NULL,
    provider_request_body = NULL,
    provider_account_type = NULL,
    provider_credential_hash = NULL,
    provider_snapshot_expires_at = NULL,
    retry_content_snapshot = NULL
WHERE log.provider_idempotency_key IS NOT NULL
   OR log.provider_request_body IS NOT NULL
   OR log.provider_account_type IS NOT NULL
   OR log.provider_credential_hash IS NOT NULL
   OR log.provider_snapshot_expires_at IS NOT NULL
   OR log.retry_content_snapshot IS NOT NULL;

ALTER TABLE public.email_log
  ADD CONSTRAINT email_log_provider_private_fields_null_chk CHECK (
    provider_idempotency_key IS NULL
    AND provider_request_body IS NULL
    AND provider_account_type IS NULL
    AND provider_credential_hash IS NULL
    AND provider_snapshot_expires_at IS NULL
    AND retry_content_snapshot IS NULL
  );

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
    'queued',
    NULL,
    p_log->>'email_category',
    NULLIF(p_log->>'related_booking_id', '')::UUID,
    NULLIF(p_log->>'related_group_id', '')::UUID,
    v_retry_of,
    p_idempotency_key
  )
  ON CONFLICT (tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
  DO NOTHING
  RETURNING target.id INTO v_log_id;

  v_inserted := v_log_id IS NOT NULL;

  IF v_inserted THEN
    INSERT INTO public.email_provider_dispatch (
      email_log_id,
      tenant_id,
      provider_idempotency_key,
      provider_request_body,
      provider_account_type,
      provider_credential_hash,
      provider_attempt_state,
      provider_snapshot_expires_at,
      retry_content_snapshot,
      created_at
    ) VALUES (
      v_log_id,
      p_tenant_id,
      p_provider_idempotency_key,
      p_provider_request_body,
      p_provider_account_type,
      p_provider_credential_hash,
      'unstarted',
      v_now + INTERVAL '23 hours',
      p_retry_content,
      v_now
    );
  END IF;

  RETURN QUERY
  SELECT
    target.id,
    target.status,
    target.sent_at,
    target.resend_message_id,
    dispatch.provider_idempotency_key,
    dispatch.provider_request_body,
    dispatch.provider_account_type,
    dispatch.provider_credential_hash,
    dispatch.provider_first_attempt_at,
    v_inserted
  FROM public.email_log AS target
  LEFT JOIN public.email_provider_dispatch AS dispatch
    ON dispatch.email_log_id = target.id
    AND dispatch.tenant_id = target.tenant_id
  WHERE target.tenant_id = p_tenant_id
    AND target.idempotency_key = p_idempotency_key;
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_idempotent_email_send_v2(
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
  provider_attempt_state TEXT,
  newly_queued BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    prepared.email_log_id,
    prepared.email_status,
    prepared.sent_at,
    prepared.resend_message_id,
    prepared.provider_idempotency_key,
    prepared.provider_request_body,
    prepared.provider_account_type,
    prepared.provider_credential_hash,
    prepared.provider_first_attempt_at,
    dispatch.provider_attempt_state,
    prepared.newly_queued
  FROM public.prepare_idempotent_email_send(
    p_tenant_id,
    p_idempotency_key,
    p_provider_idempotency_key,
    p_provider_request_body,
    p_provider_account_type,
    p_provider_credential_hash,
    p_log,
    p_retry_content
  ) AS prepared
  LEFT JOIN public.email_provider_dispatch AS dispatch
    ON dispatch.email_log_id = prepared.email_log_id
    AND dispatch.tenant_id = p_tenant_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.recover_idempotent_email_send(
  p_tenant_id UUID,
  p_idempotency_key TEXT
)
RETURNS TABLE (
  email_log_id UUID,
  email_status TEXT,
  sent_at TIMESTAMPTZ,
  resend_message_id TEXT,
  provider_first_attempt_at TIMESTAMPTZ,
  provider_attempt_state TEXT
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    target.id,
    target.status,
    target.sent_at,
    target.resend_message_id,
    dispatch.provider_first_attempt_at,
    dispatch.provider_attempt_state
  FROM public.email_log AS target
  LEFT JOIN public.email_provider_dispatch AS dispatch
    ON dispatch.email_log_id = target.id
    AND dispatch.tenant_id = target.tenant_id
  WHERE target.tenant_id = p_tenant_id
    AND target.idempotency_key = p_idempotency_key
  LIMIT 1;
$$;

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
    target.id,
    dispatch.provider_idempotency_key,
    dispatch.provider_request_body,
    dispatch.provider_account_type,
    dispatch.provider_credential_hash,
    dispatch.provider_first_attempt_at,
    dispatch.provider_snapshot_expires_at
  INTO
    v_log_id,
    v_provider_key,
    v_provider_body,
    v_provider_account_type,
    v_provider_credential_hash,
    v_first_attempt_at,
    v_snapshot_expires_at
  FROM public.email_log AS target
  JOIN public.email_provider_dispatch AS dispatch
    ON dispatch.email_log_id = target.id
    AND dispatch.tenant_id = target.tenant_id
  WHERE target.tenant_id = p_tenant_id
    AND target.idempotency_key = p_idempotency_key
    AND target.status = 'queued'
    AND target.sent_at IS NULL
    AND dispatch.provider_attempt_state IN ('unstarted', 'ambiguous', 'rejected')
  FOR UPDATE OF target, dispatch;

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
  END IF;

  UPDATE public.email_provider_dispatch AS dispatch
  SET provider_first_attempt_at = v_first_attempt_at,
      provider_attempt_state = 'ambiguous'
  WHERE dispatch.email_log_id = v_log_id
    AND dispatch.tenant_id = p_tenant_id;

  -- Mirrored only for rolling compatibility with the previous deployed
  -- reader. The private dispatch row is authoritative for new code.
  UPDATE public.email_log AS target
  SET provider_first_attempt_at = COALESCE(target.provider_first_attempt_at, v_first_attempt_at)
  WHERE target.id = v_log_id
    AND target.tenant_id = p_tenant_id;

  RETURN QUERY SELECT
    v_log_id,
    v_provider_key,
    v_provider_body,
    v_provider_account_type,
    v_provider_credential_hash,
    v_first_attempt_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_idempotent_email_dispatch_rejected(
  p_tenant_id UUID,
  p_idempotency_key TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated UUID;
BEGIN
  UPDATE public.email_provider_dispatch AS dispatch
  SET provider_attempt_state = 'rejected'
  FROM public.email_log AS target
  WHERE target.id = dispatch.email_log_id
    AND target.tenant_id = dispatch.tenant_id
    AND target.tenant_id = p_tenant_id
    AND target.idempotency_key = p_idempotency_key
    AND target.status = 'queued'
    AND target.sent_at IS NULL
    AND dispatch.provider_attempt_state = 'ambiguous'
  RETURNING dispatch.email_log_id INTO v_updated;

  RETURN v_updated IS NOT NULL;
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
  USING public.email_provider_dispatch AS dispatch
  WHERE dispatch.email_log_id = target.id
    AND dispatch.tenant_id = target.tenant_id
    AND target.tenant_id = p_tenant_id
    AND target.idempotency_key = p_idempotency_key
    AND target.status = 'queued'
    AND target.sent_at IS NULL
    AND dispatch.provider_attempt_state IN ('unstarted', 'rejected')
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
    dispatch.retry_content_snapshot
  INTO
    v_log_id,
    v_effects_recorded_at,
    v_existing_resend_message_id,
    v_retry_of,
    v_retry_content
  FROM public.email_log AS target
  JOIN public.email_provider_dispatch AS dispatch
    ON dispatch.email_log_id = target.id
    AND dispatch.tenant_id = target.tenant_id
  WHERE target.tenant_id = p_tenant_id
    AND target.idempotency_key = p_idempotency_key
  FOR UPDATE OF target, dispatch;

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
        v_now + INTERVAL '7 days'
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
    SET idempotent_effects_recorded_at = v_now
    WHERE target.id = v_log_id
      AND target.tenant_id = p_tenant_id
      AND target.idempotent_effects_recorded_at IS NULL;

    UPDATE public.email_provider_dispatch AS dispatch
    SET provider_request_body = NULL,
        provider_snapshot_expires_at = NULL,
        retry_content_snapshot = NULL
    WHERE dispatch.email_log_id = v_log_id
      AND dispatch.tenant_id = p_tenant_id;
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

REVOKE ALL ON FUNCTION public.prepare_idempotent_email_send(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_idempotent_email_send(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB)
  TO service_role;

REVOKE ALL ON FUNCTION public.prepare_idempotent_email_send_v2(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_idempotent_email_send_v2(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB)
  TO service_role;

REVOKE ALL ON FUNCTION public.recover_idempotent_email_send(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_idempotent_email_send(UUID, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION public.start_idempotent_email_dispatch(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_idempotent_email_dispatch(UUID, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION public.mark_idempotent_email_dispatch_rejected(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_idempotent_email_dispatch_rejected(UUID, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION public.abandon_unstarted_idempotent_email(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.abandon_unstarted_idempotent_email(UUID, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION public.finalize_idempotent_email_send(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_idempotent_email_send(UUID, TEXT, TEXT)
  TO service_role;
