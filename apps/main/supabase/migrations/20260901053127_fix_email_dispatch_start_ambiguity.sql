-- Migration: fix_email_dispatch_start_ambiguity
-- Version:   20260901053127
-- Generated: 2026-09-01T05:31:27Z by scripts/new-migration.sh
-- Branch:    feature/precruise-delivery-hardening
-- Worktree:  atc-precruise-2108
--
-- Qualify every email_log reference in the dispatch-start RPC. Its table
-- return column names are PL/pgSQL variables, so an unqualified
-- provider_first_attempt_at reference is ambiguous at runtime.

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
    target.provider_idempotency_key,
    target.provider_request_body,
    target.provider_account_type,
    target.provider_credential_hash,
    target.provider_first_attempt_at,
    target.provider_snapshot_expires_at
  INTO
    v_log_id,
    v_provider_key,
    v_provider_body,
    v_provider_account_type,
    v_provider_credential_hash,
    v_first_attempt_at,
    v_snapshot_expires_at
  FROM public.email_log AS target
  WHERE target.tenant_id = p_tenant_id
    AND target.idempotency_key = p_idempotency_key
    AND target.status = 'queued'
    AND target.sent_at IS NULL
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
    UPDATE public.email_log AS target
    SET provider_first_attempt_at = v_first_attempt_at
    WHERE target.id = v_log_id
      AND target.tenant_id = p_tenant_id
      AND target.provider_first_attempt_at IS NULL;
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
