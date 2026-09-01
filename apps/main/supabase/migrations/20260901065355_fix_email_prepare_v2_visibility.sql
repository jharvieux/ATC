-- Migration: fix_email_prepare_v2_visibility
-- Version:   20260901065355
-- Generated: 2026-09-01T06:53:56Z by scripts/new-migration.sh
-- Branch:    feature/precruise-delivery-hardening
-- Worktree:  atc-precruise-2108
--
-- Read the provider attempt state in a second PL/pgSQL statement after the
-- legacy prepare RPC returns. Joining the dispatch table in the same SQL
-- statement as the side-effecting function call uses the statement snapshot
-- and cannot see the row that function just inserted.

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
DECLARE
  v_prepared RECORD;
  v_provider_attempt_state TEXT;
BEGIN
  SELECT *
  INTO v_prepared
  FROM public.prepare_idempotent_email_send(
    p_tenant_id,
    p_idempotency_key,
    p_provider_idempotency_key,
    p_provider_request_body,
    p_provider_account_type,
    p_provider_credential_hash,
    p_log,
    p_retry_content
  );

  IF v_prepared.email_log_id IS NULL THEN
    RAISE EXCEPTION 'prepare_idempotent_email_send returned no row';
  END IF;

  SELECT dispatch.provider_attempt_state
  INTO v_provider_attempt_state
  FROM public.email_provider_dispatch AS dispatch
  WHERE dispatch.email_log_id = v_prepared.email_log_id
    AND dispatch.tenant_id = p_tenant_id;

  RETURN QUERY SELECT
    v_prepared.email_log_id::UUID,
    v_prepared.email_status::TEXT,
    v_prepared.sent_at::TIMESTAMPTZ,
    v_prepared.resend_message_id::TEXT,
    v_prepared.provider_idempotency_key::TEXT,
    v_prepared.provider_request_body::TEXT,
    v_prepared.provider_account_type::TEXT,
    v_prepared.provider_credential_hash::TEXT,
    v_prepared.provider_first_attempt_at::TIMESTAMPTZ,
    v_provider_attempt_state,
    v_prepared.newly_queued::BOOLEAN;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_idempotent_email_send_v2(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_idempotent_email_send_v2(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB)
  TO service_role;
