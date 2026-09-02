-- Migration: usage_limit_email_downgrade_ordering
-- Version:   20260902214154
-- Generated: 2026-09-02T21:41:54Z by scripts/new-migration.sh
-- Branch:    feature/sweep-abuse-state-2112
-- Worktree:  atc-sweep-abuse-state-2112
--
-- Propagate an authorized monthly email-state downgrade to every retained
-- daily evaluation marker in the same locked transaction. Without this, a
-- delayed marker can restore the pre-downgrade state under raised thresholds.
--
-- Rollback: restore increment_tenant_usage_counter and
-- advance_tenant_usage_state from 20260902211755, and restore
-- finalize_idempotent_email_send from 20260902191508.

CREATE OR REPLACE FUNCTION public.increment_tenant_usage_counter(
  p_tenant_id UUID,
  p_billing_period DATERANGE,
  p_dimension TEXT,
  p_amount INTEGER,
  p_evaluation_at TIMESTAMPTZ DEFAULT clock_timestamp()
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_value BIGINT;
  v_operation_day DATE := (p_evaluation_at AT TIME ZONE 'UTC')::DATE;
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
  ) VALUES (
    p_tenant_id,
    p_billing_period,
    CASE WHEN p_dimension = 'chat_volume' THEN p_amount ELSE 0 END,
    CASE WHEN p_dimension = 'email_volume' THEN p_amount ELSE 0 END,
    CASE WHEN p_dimension = 'email_volume' THEN p_amount ELSE 0 END,
    v_operation_day,
    CASE WHEN p_dimension = 'group_invite' THEN p_amount ELSE 0 END
  )
  ON CONFLICT (tenant_id, billing_period) DO UPDATE SET
    chat_messages_count = public.tenant_usage_metrics.chat_messages_count
      + CASE WHEN p_dimension = 'chat_volume' THEN p_amount ELSE 0 END,
    email_sent_count = public.tenant_usage_metrics.email_sent_count
      + CASE WHEN p_dimension = 'email_volume' THEN p_amount ELSE 0 END,
    email_sent_today = CASE
      WHEN p_dimension <> 'email_volume' THEN public.tenant_usage_metrics.email_sent_today
      WHEN public.tenant_usage_metrics.email_sent_day_ref >= v_operation_day
        THEN public.tenant_usage_metrics.email_sent_today + p_amount
      ELSE p_amount
    END,
    email_sent_day_ref = CASE
      WHEN p_dimension = 'email_volume'
        THEN GREATEST(public.tenant_usage_metrics.email_sent_day_ref, v_operation_day)
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
    requested_at = clock_timestamp();

  RETURN v_value;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.increment_tenant_usage_counter(
  UUID, DATERANGE, TEXT, INTEGER, TIMESTAMPTZ
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_tenant_usage_counter(
  UUID, DATERANGE, TEXT, INTEGER, TIMESTAMPTZ
) TO service_role;

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
        WHEN metrics.email_sent_day_ref >= v_today
          THEN metrics.email_sent_today + 1
        ELSE 1
      END,
      email_sent_day_ref = GREATEST(metrics.email_sent_day_ref, v_today)
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
      WHEN metrics.email_sent_day_ref >= v_today
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

CREATE OR REPLACE FUNCTION public.advance_tenant_usage_state(
  p_tenant_id UUID,
  p_billing_period DATERANGE,
  p_dimension TEXT,
  p_soft1 BIGINT,
  p_soft2 BIGINT,
  p_hard BIGINT,
  p_allow_downgrade BOOLEAN DEFAULT FALSE,
  p_reason TEXT DEFAULT NULL,
  p_evaluation_day DATE DEFAULT NULL
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
  v_evaluation public.usage_limit_state_evaluations%ROWTYPE;
  v_effective_day DATE;
  v_current_state TEXT;
  v_new_state TEXT;
  v_applied_state TEXT;
  v_metric BIGINT;
  v_threshold BIGINT;
  v_event_id UUID;
  v_current_rank INTEGER;
  v_new_rank INTEGER;
  v_transitioned BOOLEAN;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role'
     AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  IF p_dimension NOT IN ('ai_cost', 'chat_volume', 'email_volume', 'group_invite') THEN
    RAISE EXCEPTION 'unsupported usage dimension: %', p_dimension
      USING ERRCODE = '22023';
  END IF;
  IF p_dimension <> 'email_volume' AND p_evaluation_day IS NOT NULL THEN
    RAISE EXCEPTION 'evaluation day is supported only for email_volume'
      USING ERRCODE = '22023';
  END IF;
  IF p_soft1 < 0 OR p_soft2 < p_soft1 OR p_hard < p_soft2 THEN
    RAISE EXCEPTION 'usage thresholds must be non-negative and ordered'
      USING ERRCODE = '22023';
  END IF;

  SELECT metrics.* INTO v_metrics
  FROM public.tenant_usage_metrics AS metrics
  WHERE metrics.tenant_id = p_tenant_id
    AND metrics.billing_period = p_billing_period
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_dimension = 'email_volume' THEN
    v_effective_day := COALESCE(
      p_evaluation_day,
      (clock_timestamp() AT TIME ZONE 'UTC')::DATE
    );
    SELECT evaluation.* INTO v_evaluation
    FROM public.usage_limit_state_evaluations AS evaluation
    WHERE evaluation.tenant_id = p_tenant_id
      AND evaluation.dimension = 'email_volume'
      AND evaluation.billing_period = p_billing_period
      AND evaluation.evaluation_day = v_effective_day
    FOR UPDATE;

    IF FOUND THEN
      v_metric := v_evaluation.evaluation_value;
      v_current_state := CASE
        WHEN CASE v_metrics.email_volume_limit_state
          WHEN 'ok' THEN 0 WHEN 'soft1' THEN 1 WHEN 'soft2' THEN 2 ELSE 3
        END > CASE v_evaluation.evaluated_state
          WHEN 'ok' THEN 0 WHEN 'soft1' THEN 1 WHEN 'soft2' THEN 2 ELSE 3
        END
          THEN v_metrics.email_volume_limit_state
        ELSE v_evaluation.evaluated_state
      END;
    ELSIF v_metrics.email_sent_day_ref = v_effective_day THEN
      v_metric := v_metrics.email_sent_today::BIGINT;
      v_current_state := v_metrics.email_volume_limit_state;
    ELSE
      RETURN;
    END IF;
  ELSE
    v_metric := CASE p_dimension
      WHEN 'ai_cost' THEN v_metrics.ai_cost_cents
      WHEN 'chat_volume' THEN v_metrics.chat_messages_count::BIGINT
      ELSE v_metrics.group_invitees_count::BIGINT
    END;
    v_current_state := CASE p_dimension
      WHEN 'ai_cost' THEN v_metrics.ai_cost_limit_state
      WHEN 'chat_volume' THEN v_metrics.chat_volume_limit_state
      ELSE v_metrics.group_invite_limit_state
    END;
  END IF;

  v_new_state := CASE
    WHEN v_metric >= p_hard THEN 'hard'
    WHEN v_metric >= p_soft2 THEN 'soft2'
    WHEN v_metric >= p_soft1 THEN 'soft1'
    ELSE 'ok'
  END;
  v_current_rank := CASE v_current_state
    WHEN 'ok' THEN 0 WHEN 'soft1' THEN 1 WHEN 'soft2' THEN 2 ELSE 3
  END;
  v_new_rank := CASE v_new_state
    WHEN 'ok' THEN 0 WHEN 'soft1' THEN 1 WHEN 'soft2' THEN 2 ELSE 3
  END;
  v_transitioned := v_new_state <> v_current_state
    AND (p_allow_downgrade OR v_new_rank > v_current_rank);
  v_applied_state := CASE WHEN v_transitioned THEN v_new_state ELSE v_current_state END;

  UPDATE public.tenant_usage_metrics AS metrics SET
    ai_cost_limit_state = CASE
      WHEN p_dimension = 'ai_cost' THEN v_applied_state ELSE metrics.ai_cost_limit_state
    END,
    ai_cost_state_changed_at = CASE
      WHEN p_dimension = 'ai_cost' AND v_transitioned THEN NOW()
      ELSE metrics.ai_cost_state_changed_at
    END,
    chat_volume_limit_state = CASE
      WHEN p_dimension = 'chat_volume' THEN v_applied_state ELSE metrics.chat_volume_limit_state
    END,
    chat_volume_state_changed_at = CASE
      WHEN p_dimension = 'chat_volume' AND v_transitioned THEN NOW()
      ELSE metrics.chat_volume_state_changed_at
    END,
    email_volume_limit_state = CASE
      WHEN p_dimension = 'email_volume' THEN v_applied_state
      ELSE metrics.email_volume_limit_state
    END,
    email_volume_state_changed_at = CASE
      WHEN p_dimension = 'email_volume'
        AND metrics.email_volume_limit_state <> v_applied_state
        THEN NOW()
      ELSE metrics.email_volume_state_changed_at
    END,
    group_invite_limit_state = CASE
      WHEN p_dimension = 'group_invite' THEN v_applied_state ELSE metrics.group_invite_limit_state
    END,
    group_invite_state_changed_at = CASE
      WHEN p_dimension = 'group_invite' AND v_transitioned THEN NOW()
      ELSE metrics.group_invite_state_changed_at
    END
  WHERE metrics.id = v_metrics.id
    AND metrics.tenant_id = p_tenant_id;

  IF p_dimension = 'email_volume'
     AND p_allow_downgrade
     AND v_transitioned
     AND v_new_rank < v_current_rank THEN
    UPDATE public.usage_limit_state_evaluations AS evaluation SET
      evaluated_state = v_applied_state
    WHERE evaluation.tenant_id = p_tenant_id
      AND evaluation.dimension = 'email_volume'
      AND evaluation.billing_period = p_billing_period;
  END IF;

  IF p_dimension = 'email_volume' AND v_evaluation.id IS NOT NULL THEN
    UPDATE public.usage_limit_state_evaluations AS evaluation SET
      evaluated_state = v_applied_state,
      pending = FALSE
    WHERE evaluation.id = v_evaluation.id
      AND evaluation.tenant_id = p_tenant_id
      AND evaluation.billing_period = p_billing_period
      AND evaluation.evaluation_day = v_effective_day;
  ELSIF p_dimension <> 'email_volume' THEN
    DELETE FROM public.usage_limit_state_evaluations AS evaluation
    WHERE evaluation.tenant_id = p_tenant_id
      AND evaluation.dimension = p_dimension
      AND evaluation.billing_period = p_billing_period
      AND evaluation.evaluation_day IS NULL;
  END IF;

  IF v_transitioned THEN
    v_threshold := CASE v_new_state
      WHEN 'hard' THEN p_hard
      WHEN 'soft2' THEN p_soft2
      WHEN 'soft1' THEN p_soft1
      ELSE 0
    END;

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

  RETURN QUERY
  SELECT
    event.id,
    event.tenant_id,
    event.dimension,
    event.from_state,
    event.to_state,
    event.metric_value,
    event.threshold_crossed,
    FALSE
  FROM public.usage_limit_events AS event
  WHERE event.tenant_id = p_tenant_id
    AND event.dimension = p_dimension
    AND event.event_dispatch_pending
  ORDER BY event.triggered_at, event.id
  LIMIT 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.advance_tenant_usage_state(
  UUID, DATERANGE, TEXT, BIGINT, BIGINT, BIGINT, BOOLEAN, TEXT, DATE
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.advance_tenant_usage_state(
  UUID, DATERANGE, TEXT, BIGINT, BIGINT, BIGINT, BOOLEAN, TEXT, DATE
) TO service_role;
