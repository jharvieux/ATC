-- Migration: usage_limit_state_outbox
-- Version:   20260902191508
-- Generated: 2026-09-02T19:15:08Z by scripts/new-migration.sh
-- Branch:    feature/sweep-abuse-state-2112
-- Worktree:  atc-sweep-abuse-state-2112
--
-- Make usage counter increments atomic and bind each state advancement to a
-- durable outbox marker in the same transaction. Application retries dispatch
-- the marker with a deterministic Inngest event id; a periodic recovery path
-- handles a process crash after commit but before dispatch.
--
-- Rollback: remove the functions/grants below and the two outbox columns after
-- all callers have moved back to direct writes. The columns are additive and
-- historical usage_limit_events remain valid with their default values.

ALTER TABLE public.usage_limit_events
  ADD COLUMN event_dispatch_pending BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN event_dispatched_at TIMESTAMPTZ;

CREATE INDEX usage_limit_events_dispatch_pending_idx
  ON public.usage_limit_events(triggered_at, id)
  WHERE event_dispatch_pending;

CREATE TABLE public.usage_limit_state_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL CHECK (dimension IN (
    'ai_cost', 'chat_volume', 'email_volume', 'group_invite', 'rag_cap'
  )),
  billing_period DATERANGE,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT usage_limit_state_evaluations_scope_uidx
    UNIQUE NULLS NOT DISTINCT (tenant_id, dimension, billing_period)
);

CREATE INDEX usage_limit_state_evaluations_requested_idx
  ON public.usage_limit_state_evaluations(requested_at, tenant_id);

ALTER TABLE public.usage_limit_state_evaluations ENABLE ROW LEVEL SECURITY;

CREATE POLICY usage_limit_state_evaluations_no_user_select
  ON public.usage_limit_state_evaluations FOR SELECT USING (FALSE);
CREATE POLICY usage_limit_state_evaluations_no_user_insert
  ON public.usage_limit_state_evaluations FOR INSERT WITH CHECK (FALSE);
CREATE POLICY usage_limit_state_evaluations_no_user_update
  ON public.usage_limit_state_evaluations FOR UPDATE USING (FALSE);
CREATE POLICY usage_limit_state_evaluations_no_user_delete
  ON public.usage_limit_state_evaluations FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.usage_limit_state_evaluations TO service_role;

CREATE OR REPLACE FUNCTION public.increment_tenant_ai_cost(
  p_tenant_id UUID,
  p_billing_period DATERANGE,
  p_amount_cents BIGINT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role'
     AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.tenant_usage_metrics (tenant_id, billing_period, ai_cost_cents)
  VALUES (p_tenant_id, p_billing_period, p_amount_cents)
  ON CONFLICT (tenant_id, billing_period) DO UPDATE SET
    ai_cost_cents = public.tenant_usage_metrics.ai_cost_cents + EXCLUDED.ai_cost_cents;

  INSERT INTO public.usage_limit_state_evaluations (tenant_id, dimension, billing_period)
  VALUES (p_tenant_id, 'ai_cost', p_billing_period)
  ON CONFLICT ON CONSTRAINT usage_limit_state_evaluations_scope_uidx DO UPDATE SET
    requested_at = NOW();
END;
$$;

REVOKE EXECUTE ON FUNCTION public.increment_tenant_ai_cost(UUID, DATERANGE, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_tenant_ai_cost(UUID, DATERANGE, BIGINT) TO service_role;

CREATE OR REPLACE FUNCTION public.increment_tenant_usage_counter(
  p_tenant_id UUID,
  p_billing_period DATERANGE,
  p_dimension TEXT,
  p_amount INTEGER
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_value BIGINT;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role'
     AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  IF p_dimension NOT IN ('chat_volume', 'email_volume', 'group_invite') THEN
    RAISE EXCEPTION 'unsupported usage counter dimension: %', p_dimension
      USING ERRCODE = '22023';
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'usage counter amount must be positive'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.tenant_usage_metrics (
    tenant_id,
    billing_period,
    chat_messages_count,
    email_sent_count,
    email_sent_today,
    email_sent_day_ref,
    group_invitees_count
  )
  VALUES (
    p_tenant_id,
    p_billing_period,
    CASE WHEN p_dimension = 'chat_volume' THEN p_amount ELSE 0 END,
    CASE WHEN p_dimension = 'email_volume' THEN p_amount ELSE 0 END,
    CASE WHEN p_dimension = 'email_volume' THEN p_amount ELSE 0 END,
    CURRENT_DATE,
    CASE WHEN p_dimension = 'group_invite' THEN p_amount ELSE 0 END
  )
  ON CONFLICT (tenant_id, billing_period) DO UPDATE SET
    chat_messages_count = public.tenant_usage_metrics.chat_messages_count
      + CASE WHEN p_dimension = 'chat_volume' THEN p_amount ELSE 0 END,
    email_sent_count = public.tenant_usage_metrics.email_sent_count
      + CASE WHEN p_dimension = 'email_volume' THEN p_amount ELSE 0 END,
    email_sent_today = CASE
      WHEN p_dimension <> 'email_volume' THEN public.tenant_usage_metrics.email_sent_today
      WHEN public.tenant_usage_metrics.email_sent_day_ref = CURRENT_DATE
        THEN public.tenant_usage_metrics.email_sent_today + p_amount
      ELSE p_amount
    END,
    email_sent_day_ref = CASE
      WHEN p_dimension = 'email_volume' THEN CURRENT_DATE
      ELSE public.tenant_usage_metrics.email_sent_day_ref
    END,
    group_invitees_count = public.tenant_usage_metrics.group_invitees_count
      + CASE WHEN p_dimension = 'group_invite' THEN p_amount ELSE 0 END
  RETURNING CASE p_dimension
    WHEN 'chat_volume' THEN chat_messages_count::BIGINT
    WHEN 'email_volume' THEN email_sent_today::BIGINT
    ELSE group_invitees_count::BIGINT
  END INTO v_value;

  INSERT INTO public.usage_limit_state_evaluations (tenant_id, dimension, billing_period)
  VALUES (p_tenant_id, p_dimension, p_billing_period)
  ON CONFLICT ON CONSTRAINT usage_limit_state_evaluations_scope_uidx DO UPDATE SET
    requested_at = NOW();

  RETURN v_value;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.increment_tenant_usage_counter(UUID, DATERANGE, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_tenant_usage_counter(UUID, DATERANGE, TEXT, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.adjust_tenant_rag_usage(
  p_tenant_id UUID,
  p_delta INTEGER,
  p_promoted_chunks_count INTEGER
)
RETURNS TABLE (
  current_tenant_chunks_count INTEGER,
  promoted_chunks_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
  v_promoted INTEGER;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role'
     AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  IF p_promoted_chunks_count < 0 THEN
    RAISE EXCEPTION 'promoted chunk count cannot be negative'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.tenant_rag_quotas (
    tenant_id,
    base_cap,
    promoted_chunks_count,
    current_tenant_chunks_count
  )
  VALUES (
    p_tenant_id,
    0,
    p_promoted_chunks_count,
    GREATEST(0, p_delta)
  )
  ON CONFLICT (tenant_id) DO UPDATE SET
    current_tenant_chunks_count = GREATEST(
      0,
      public.tenant_rag_quotas.current_tenant_chunks_count + p_delta
    ),
    updated_at = NOW()
  RETURNING
    public.tenant_rag_quotas.current_tenant_chunks_count,
    public.tenant_rag_quotas.promoted_chunks_count
  INTO v_count, v_promoted;

  INSERT INTO public.usage_limit_state_evaluations (tenant_id, dimension, billing_period)
  VALUES (p_tenant_id, 'rag_cap', NULL)
  ON CONFLICT ON CONSTRAINT usage_limit_state_evaluations_scope_uidx DO UPDATE SET
    requested_at = NOW();

  RETURN QUERY SELECT v_count, v_promoted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.adjust_tenant_rag_usage(UUID, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.adjust_tenant_rag_usage(UUID, INTEGER, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.advance_tenant_usage_state(
  p_tenant_id UUID,
  p_billing_period DATERANGE,
  p_dimension TEXT,
  p_soft1 BIGINT,
  p_soft2 BIGINT,
  p_hard BIGINT,
  p_allow_downgrade BOOLEAN DEFAULT FALSE,
  p_reason TEXT DEFAULT NULL
)
RETURNS TABLE (
  event_id UUID,
  event_tenant_id UUID,
  event_dimension TEXT,
  event_from_state TEXT,
  event_to_state TEXT,
  event_metric_value BIGINT,
  event_threshold_crossed BIGINT,
  event_created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_metrics public.tenant_usage_metrics%ROWTYPE;
  v_current_state TEXT;
  v_new_state TEXT;
  v_metric BIGINT;
  v_threshold BIGINT;
  v_event_id UUID;
  v_current_rank INTEGER;
  v_new_rank INTEGER;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role'
     AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  IF p_dimension NOT IN ('ai_cost', 'chat_volume', 'email_volume', 'group_invite') THEN
    RAISE EXCEPTION 'unsupported monthly usage dimension: %', p_dimension
      USING ERRCODE = '22023';
  END IF;
  IF p_soft1 < 0 OR p_soft2 < p_soft1 OR p_hard < p_soft2 THEN
    RAISE EXCEPTION 'usage thresholds must be non-negative and ordered'
      USING ERRCODE = '22023';
  END IF;

  SELECT tum.* INTO v_metrics
  FROM public.tenant_usage_metrics AS tum
  WHERE tum.tenant_id = p_tenant_id
    AND tum.billing_period = p_billing_period
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_metric := CASE p_dimension
    WHEN 'ai_cost' THEN v_metrics.ai_cost_cents
    WHEN 'chat_volume' THEN v_metrics.chat_messages_count::BIGINT
    WHEN 'email_volume' THEN v_metrics.email_sent_today::BIGINT
    ELSE v_metrics.group_invitees_count::BIGINT
  END;
  v_current_state := CASE p_dimension
    WHEN 'ai_cost' THEN v_metrics.ai_cost_limit_state
    WHEN 'chat_volume' THEN v_metrics.chat_volume_limit_state
    WHEN 'email_volume' THEN v_metrics.email_volume_limit_state
    ELSE v_metrics.group_invite_limit_state
  END;
  v_new_state := CASE
    WHEN v_metric >= p_hard THEN 'hard'
    WHEN v_metric >= p_soft2 THEN 'soft2'
    WHEN v_metric >= p_soft1 THEN 'soft1'
    ELSE 'ok'
  END;
  v_current_rank := CASE v_current_state WHEN 'ok' THEN 0 WHEN 'soft1' THEN 1 WHEN 'soft2' THEN 2 ELSE 3 END;
  v_new_rank := CASE v_new_state WHEN 'ok' THEN 0 WHEN 'soft1' THEN 1 WHEN 'soft2' THEN 2 ELSE 3 END;

  IF v_new_state <> v_current_state
     AND (p_allow_downgrade OR v_new_rank > v_current_rank) THEN
    v_threshold := CASE v_new_state
      WHEN 'hard' THEN p_hard
      WHEN 'soft2' THEN p_soft2
      WHEN 'soft1' THEN p_soft1
      ELSE 0
    END;

    UPDATE public.tenant_usage_metrics AS tum SET
      ai_cost_limit_state = CASE WHEN p_dimension = 'ai_cost' THEN v_new_state ELSE tum.ai_cost_limit_state END,
      ai_cost_state_changed_at = CASE WHEN p_dimension = 'ai_cost' THEN NOW() ELSE tum.ai_cost_state_changed_at END,
      chat_volume_limit_state = CASE WHEN p_dimension = 'chat_volume' THEN v_new_state ELSE tum.chat_volume_limit_state END,
      chat_volume_state_changed_at = CASE WHEN p_dimension = 'chat_volume' THEN NOW() ELSE tum.chat_volume_state_changed_at END,
      email_volume_limit_state = CASE WHEN p_dimension = 'email_volume' THEN v_new_state ELSE tum.email_volume_limit_state END,
      email_volume_state_changed_at = CASE WHEN p_dimension = 'email_volume' THEN NOW() ELSE tum.email_volume_state_changed_at END,
      group_invite_limit_state = CASE WHEN p_dimension = 'group_invite' THEN v_new_state ELSE tum.group_invite_limit_state END,
      group_invite_state_changed_at = CASE WHEN p_dimension = 'group_invite' THEN NOW() ELSE tum.group_invite_state_changed_at END
    WHERE tum.id = v_metrics.id
      AND tum.tenant_id = p_tenant_id;

    INSERT INTO public.usage_limit_events (
      tenant_id,
      dimension,
      from_state,
      to_state,
      metric_value,
      threshold_crossed,
      resolution_action,
      event_dispatch_pending
    ) VALUES (
      p_tenant_id,
      p_dimension,
      v_current_state,
      v_new_state,
      v_metric,
      v_threshold,
      COALESCE(p_reason, 'state_transition'),
      TRUE
    ) RETURNING id INTO v_event_id;

    DELETE FROM public.usage_limit_state_evaluations
    WHERE tenant_id = p_tenant_id
      AND dimension = p_dimension
      AND billing_period = p_billing_period;

    RETURN QUERY SELECT
      v_event_id,
      p_tenant_id,
      p_dimension,
      v_current_state,
      v_new_state,
      v_metric,
      v_threshold,
      TRUE;
    RETURN;
  END IF;

  DELETE FROM public.usage_limit_state_evaluations
  WHERE tenant_id = p_tenant_id
    AND dimension = p_dimension
    AND billing_period = p_billing_period;

  RETURN QUERY
  SELECT
    ule.id,
    ule.tenant_id,
    ule.dimension,
    ule.from_state,
    ule.to_state,
    ule.metric_value,
    ule.threshold_crossed,
    FALSE
  FROM public.usage_limit_events AS ule
  WHERE ule.tenant_id = p_tenant_id
    AND ule.dimension = p_dimension
    AND ule.event_dispatch_pending
  ORDER BY ule.triggered_at, ule.id
  LIMIT 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.advance_tenant_usage_state(UUID, DATERANGE, TEXT, BIGINT, BIGINT, BIGINT, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.advance_tenant_usage_state(UUID, DATERANGE, TEXT, BIGINT, BIGINT, BIGINT, BOOLEAN, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.advance_tenant_rag_state(
  p_tenant_id UUID,
  p_approaching INTEGER,
  p_effective INTEGER,
  p_reason TEXT DEFAULT NULL
)
RETURNS TABLE (
  event_id UUID,
  event_tenant_id UUID,
  event_dimension TEXT,
  event_from_state TEXT,
  event_to_state TEXT,
  event_metric_value BIGINT,
  event_threshold_crossed BIGINT,
  event_created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_quota public.tenant_rag_quotas%ROWTYPE;
  v_new_state TEXT;
  v_event_id UUID;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role'
     AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  IF p_approaching < 0 OR p_effective < p_approaching THEN
    RAISE EXCEPTION 'RAG thresholds must be non-negative and ordered'
      USING ERRCODE = '22023';
  END IF;

  SELECT trq.* INTO v_quota
  FROM public.tenant_rag_quotas AS trq
  WHERE trq.tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_new_state := CASE
    WHEN v_quota.current_tenant_chunks_count > p_effective THEN 'over_cap'
    WHEN v_quota.current_tenant_chunks_count = p_effective THEN 'at_cap'
    WHEN v_quota.current_tenant_chunks_count >= p_approaching THEN 'approaching'
    ELSE 'ok'
  END;

  IF v_new_state <> v_quota.rag_state THEN
    UPDATE public.tenant_rag_quotas AS trq SET
      rag_state = v_new_state,
      rag_state_changed_at = NOW(),
      updated_at = NOW()
    WHERE trq.tenant_id = p_tenant_id;

    INSERT INTO public.tenant_rag_cap_events (
      tenant_id,
      event_type,
      cap_before,
      cap_after,
      count_before,
      count_after,
      reason
    ) VALUES (
      p_tenant_id,
      'state_transition',
      p_effective,
      p_effective,
      v_quota.current_tenant_chunks_count,
      v_quota.current_tenant_chunks_count,
      v_quota.rag_state || ' → ' || v_new_state
    );

    INSERT INTO public.usage_limit_events (
      tenant_id,
      dimension,
      from_state,
      to_state,
      metric_value,
      threshold_crossed,
      resolution_action,
      event_dispatch_pending
    ) VALUES (
      p_tenant_id,
      'rag_cap',
      v_quota.rag_state,
      v_new_state,
      v_quota.current_tenant_chunks_count,
      p_effective,
      COALESCE(p_reason, 'state_transition'),
      TRUE
    ) RETURNING id INTO v_event_id;

    DELETE FROM public.usage_limit_state_evaluations
    WHERE tenant_id = p_tenant_id
      AND dimension = 'rag_cap'
      AND billing_period IS NULL;

    RETURN QUERY SELECT
      v_event_id,
      p_tenant_id,
      'rag_cap'::TEXT,
      v_quota.rag_state,
      v_new_state,
      v_quota.current_tenant_chunks_count::BIGINT,
      p_effective::BIGINT,
      TRUE;
    RETURN;
  END IF;

  DELETE FROM public.usage_limit_state_evaluations
  WHERE tenant_id = p_tenant_id
    AND dimension = 'rag_cap'
    AND billing_period IS NULL;

  RETURN QUERY
  SELECT
    ule.id,
    ule.tenant_id,
    ule.dimension,
    ule.from_state,
    ule.to_state,
    ule.metric_value,
    ule.threshold_crossed,
    FALSE
  FROM public.usage_limit_events AS ule
  WHERE ule.tenant_id = p_tenant_id
    AND ule.dimension = 'rag_cap'
    AND ule.event_dispatch_pending
  ORDER BY ule.triggered_at, ule.id
  LIMIT 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.advance_tenant_rag_state(UUID, INTEGER, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.advance_tenant_rag_state(UUID, INTEGER, INTEGER, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.increment_help_submission_usage(
  p_tenant_id UUID,
  p_billing_period DATERANGE,
  p_soft1 INTEGER,
  p_soft2 INTEGER,
  p_hard INTEGER
)
RETURNS TABLE (
  new_count INTEGER,
  new_state TEXT,
  transitioned BOOLEAN,
  event_id UUID,
  event_tenant_id UUID,
  event_dimension TEXT,
  event_from_state TEXT,
  event_to_state TEXT,
  event_metric_value BIGINT,
  event_threshold_crossed BIGINT,
  event_created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_metrics public.tenant_usage_metrics%ROWTYPE;
  v_previous_state TEXT;
  v_new_state TEXT;
  v_threshold INTEGER;
  v_event public.usage_limit_events%ROWTYPE;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role'
     AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  IF p_soft1 < 0 OR p_soft2 < p_soft1 OR p_hard < p_soft2 THEN
    RAISE EXCEPTION 'help thresholds must be non-negative and ordered'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.tenant_usage_metrics (
    tenant_id,
    billing_period,
    help_submission_count,
    last_recomputed_at
  ) VALUES (
    p_tenant_id,
    p_billing_period,
    1,
    NOW()
  )
  ON CONFLICT (tenant_id, billing_period) DO UPDATE SET
    help_submission_count = public.tenant_usage_metrics.help_submission_count + 1,
    last_recomputed_at = NOW()
  RETURNING * INTO v_metrics;

  v_previous_state := v_metrics.help_submission_limit_state;
  v_new_state := CASE
    WHEN v_metrics.help_submission_count >= p_hard THEN 'hard'
    WHEN v_metrics.help_submission_count >= p_soft2 THEN 'soft2'
    WHEN v_metrics.help_submission_count >= p_soft1 THEN 'soft1'
    ELSE 'ok'
  END;

  IF v_new_state <> v_previous_state THEN
    v_threshold := CASE v_new_state
      WHEN 'hard' THEN p_hard
      WHEN 'soft2' THEN p_soft2
      WHEN 'soft1' THEN p_soft1
      ELSE 0
    END;

    UPDATE public.tenant_usage_metrics AS tum SET
      help_submission_limit_state = v_new_state,
      help_submission_state_changed_at = NOW()
    WHERE tum.id = v_metrics.id
      AND tum.tenant_id = p_tenant_id;

    INSERT INTO public.usage_limit_events (
      tenant_id,
      dimension,
      from_state,
      to_state,
      metric_value,
      threshold_crossed,
      resolution_action,
      event_dispatch_pending
    ) VALUES (
      p_tenant_id,
      'help_submission',
      v_previous_state,
      v_new_state,
      v_metrics.help_submission_count,
      v_threshold,
      'state_transition',
      v_new_state = 'soft2'
    ) RETURNING * INTO v_event;
  ELSE
    SELECT ule.* INTO v_event
    FROM public.usage_limit_events AS ule
    WHERE ule.tenant_id = p_tenant_id
      AND ule.dimension = 'help_submission'
      AND ule.event_dispatch_pending
    ORDER BY ule.triggered_at, ule.id
    LIMIT 1;
  END IF;

  RETURN QUERY SELECT
    v_metrics.help_submission_count,
    v_new_state,
    v_new_state <> v_previous_state,
    v_event.id,
    v_event.tenant_id,
    v_event.dimension,
    v_event.from_state,
    v_event.to_state,
    v_event.metric_value,
    v_event.threshold_crossed,
    v_event.id IS NOT NULL AND v_new_state <> v_previous_state;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.increment_help_submission_usage(UUID, DATERANGE, INTEGER, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_help_submission_usage(UUID, DATERANGE, INTEGER, INTEGER, INTEGER) TO service_role;

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

    INSERT INTO public.usage_limit_state_evaluations (tenant_id, dimension, billing_period)
    VALUES (p_tenant_id, 'email_volume', v_period)
    ON CONFLICT ON CONSTRAINT usage_limit_state_evaluations_scope_uidx DO UPDATE SET
      requested_at = NOW();

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

COMMENT ON COLUMN public.usage_limit_events.event_dispatch_pending IS
  'Durable outbox marker set in the same transaction as state advancement; cleared only after deterministic Inngest dispatch succeeds.';
COMMENT ON TABLE public.usage_limit_state_evaluations IS
  '#2112: durable recovery queue written atomically with counter mutations and cleared atomically with authoritative state evaluation.';
COMMENT ON FUNCTION public.increment_tenant_ai_cost(UUID, DATERANGE, BIGINT) IS
  '#2112: atomically increments AI cost and records a durable pending state evaluation for crash recovery.';
COMMENT ON FUNCTION public.increment_tenant_usage_counter(UUID, DATERANGE, TEXT, INTEGER) IS
  '#2112: atomically increments chat, email-day, or group-invite usage and returns the post-increment value.';
COMMENT ON FUNCTION public.adjust_tenant_rag_usage(UUID, INTEGER, INTEGER) IS
  '#2112: atomically adjusts a tenant RAG count with a zero floor and returns the post-adjustment value.';
COMMENT ON FUNCTION public.advance_tenant_usage_state(UUID, DATERANGE, TEXT, BIGINT, BIGINT, BIGINT, BOOLEAN, TEXT) IS
  '#2112: serializes monthly state advancement and inserts its usage_limit_events outbox marker in the same transaction.';
COMMENT ON FUNCTION public.advance_tenant_rag_state(UUID, INTEGER, INTEGER, TEXT) IS
  '#2112: serializes non-monotonic RAG state changes and atomically writes both audit records plus the outbox marker.';
COMMENT ON FUNCTION public.increment_help_submission_usage(UUID, DATERANGE, INTEGER, INTEGER, INTEGER) IS
  '#2112: atomically increments per-day help usage, advances its state, and records an outbox event.';
COMMENT ON FUNCTION public.finalize_idempotent_email_send(UUID, TEXT, TEXT) IS
  '#2112: atomically finalizes an idempotent email, increments usage, and records its pending email-volume state evaluation.';
