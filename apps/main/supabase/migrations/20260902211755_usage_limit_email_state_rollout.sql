-- Migration: usage_limit_email_state_rollout
-- Version:   20260902211755
-- Generated: 2026-09-02T21:17:55Z by scripts/new-migration.sh
-- Branch:    feature/sweep-abuse-state-2112
-- Worktree:  atc-sweep-abuse-state-2112
--
-- Preserve the authoritative monthly email-volume state when creating or
-- recovering daily counter-window markers. Add a partial recovery index so
-- retained completed daily markers do not slow the pending scan.
--
-- Rollback: drop usage_limit_state_evaluations_pending_idx, restore
-- capture_email_usage_evaluation_window and advance_tenant_usage_state from
-- 20260902205406, and restore marker states only from an external audit trail.

CREATE INDEX IF NOT EXISTS usage_limit_state_evaluations_pending_idx
  ON public.usage_limit_state_evaluations(requested_at, tenant_id)
  WHERE pending;

UPDATE public.usage_limit_state_evaluations AS evaluation
SET evaluated_state = metrics.email_volume_limit_state
FROM public.tenant_usage_metrics AS metrics
WHERE evaluation.dimension = 'email_volume'
  AND metrics.tenant_id = evaluation.tenant_id
  AND metrics.billing_period = evaluation.billing_period;

CREATE OR REPLACE FUNCTION public.capture_email_usage_evaluation_window()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.dimension <> 'email_volume' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT
      metrics.email_sent_day_ref,
      metrics.email_sent_today::BIGINT,
      metrics.email_volume_limit_state
    INTO NEW.evaluation_day, NEW.evaluation_value, NEW.evaluated_state
    FROM public.tenant_usage_metrics AS metrics
    WHERE metrics.tenant_id = NEW.tenant_id
      AND metrics.billing_period = NEW.billing_period;

    IF NEW.evaluation_day IS NULL OR NEW.evaluation_value IS NULL THEN
      RAISE EXCEPTION 'email usage evaluation requires an authoritative daily counter'
        USING ERRCODE = '23514';
    END IF;
    NEW.pending := TRUE;
  ELSIF NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    SELECT metrics.email_sent_day_ref, metrics.email_sent_today::BIGINT
    INTO NEW.evaluation_day, NEW.evaluation_value
    FROM public.tenant_usage_metrics AS metrics
    WHERE metrics.tenant_id = NEW.tenant_id
      AND metrics.billing_period = NEW.billing_period;

    IF NEW.evaluation_day IS NULL OR NEW.evaluation_value IS NULL THEN
      RAISE EXCEPTION 'email usage evaluation requires an authoritative daily counter'
        USING ERRCODE = '23514';
    END IF;
    NEW.evaluated_state := OLD.evaluated_state;
    NEW.pending := TRUE;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.capture_email_usage_evaluation_window() FROM PUBLIC;

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

COMMENT ON INDEX public.usage_limit_state_evaluations_pending_idx IS
  '#2112: bounds recovery scans to rows that still require state evaluation.';
