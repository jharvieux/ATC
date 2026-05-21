-- §6.10: Customer Feedback Confidence Factor
--
-- Adds feedback tracking columns to knowledge_chunks, the feedback event
-- table, and the compute_feedback_factor() recomputation function.
--
-- The feedback_confidence_factor is a FOURTH scoring input to retrieval,
-- additive to the existing relevance × authority × recency composite:
--   composite_confidence = (match_score × authority × recency) + feedback_factor
--
-- feedback_factor is clamped to [-limit, +limit] where limit is configured
-- in platform_settings (default 0.05). Reads platform_settings at invocation
-- time — no batch reprocessing needed when knobs change.

ALTER TABLE public.knowledge_chunks
  ADD COLUMN feedback_signal_count    INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN feedback_weighted_sum    NUMERIC(8,4) NOT NULL DEFAULT 0,
  ADD COLUMN feedback_last_recompute_at TIMESTAMPTZ;

-- Feedback events: one row per thumbs-up/down on a message that cited a chunk.
-- message_id references the main app's public.messages(id) — the FK is not
-- declared here because knowledge_chunk_feedback_events lives in the RAG project
-- while messages lives in the main app project (cross-project FK not supported).
CREATE TABLE public.knowledge_chunk_feedback_events (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id         UUID        NOT NULL REFERENCES public.knowledge_chunks(id) ON DELETE CASCADE,
  -- TODO(main-app-fk): add FK to main app's public.messages(id) when cross-project
  -- FK support is available, or enforce via application logic.
  message_id       UUID,
  signal_direction TEXT        NOT NULL CHECK (signal_direction IN ('up','down')),
  -- Raw weight contribution at the moment of capture, before decay.
  raw_weight       NUMERIC(4,2) NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX kcfe_chunk_time_idx
  ON public.knowledge_chunk_feedback_events(chunk_id, created_at DESC);

-- Recomputation function — verbatim from spec §6.10.
-- STABLE (deterministic within a transaction; application caches per-chunk
-- for 5 minutes at the retrieval layer).
-- Reads platform_settings from this project's replica (migration 0006).
CREATE OR REPLACE FUNCTION public.compute_feedback_factor(
  p_chunk_id UUID
) RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_adjustment_limit    NUMERIC;
  v_min_signal_count    INTEGER;
  v_period_days         INTEGER;
  v_halflife_days       INTEGER;
  v_recent_signal_count INTEGER;
  v_decay_weighted_sum  NUMERIC;
BEGIN
  -- Read current platform settings (from local replica — see migration 0006).
  SELECT value::NUMERIC INTO v_adjustment_limit
    FROM public.platform_settings WHERE key = 'feedback_adjustment_limit';
  SELECT value::INTEGER INTO v_min_signal_count
    FROM public.platform_settings WHERE key = 'feedback_min_signal_count';
  SELECT value::INTEGER INTO v_period_days
    FROM public.platform_settings WHERE key = 'feedback_period_days';
  SELECT value::INTEGER INTO v_halflife_days
    FROM public.platform_settings WHERE key = 'feedback_decay_halflife_days';

  -- Gate: minimum signal count within the lookback period.
  SELECT COUNT(*) INTO v_recent_signal_count
    FROM public.knowledge_chunk_feedback_events
    WHERE chunk_id = p_chunk_id
      AND created_at >= NOW() - (v_period_days || ' days')::INTERVAL;

  IF v_recent_signal_count < v_min_signal_count THEN
    RETURN 0;
  END IF;

  -- Cumulative-with-decay: sum of raw_weight × decay factor.
  SELECT COALESCE(SUM(
    raw_weight * POWER(0.5, EXTRACT(EPOCH FROM (NOW() - created_at))
    / 86400.0 / v_halflife_days)
  ), 0) INTO v_decay_weighted_sum
    FROM public.knowledge_chunk_feedback_events
    WHERE chunk_id = p_chunk_id;

  -- Clamp to [-limit, +limit].
  -- The * 0.01 scaling factor converts raw weighted-sum units into the
  -- adjustment scale. Calibrate during Phase 1.
  RETURN GREATEST(-v_adjustment_limit,
                  LEAST(v_adjustment_limit, v_decay_weighted_sum * 0.01));
END;
$$;
