-- §6.12 — Retrieval log aggregation.
--
-- After 90 days the per-call rag_retrieval_log rows are deleted; this
-- daily aggregate is kept for long-term trend analysis. Group by
-- (tenant_id, day, outcome); store request count + average + p95
-- latency.

CREATE TABLE IF NOT EXISTS public.rag_retrieval_log_daily (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL,
  day             DATE        NOT NULL,
  outcome         TEXT        NOT NULL,
  request_count   INTEGER     NOT NULL,
  avg_latency_ms  INTEGER     NOT NULL,
  p95_latency_ms  INTEGER     NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, day, outcome)
);

CREATE INDEX rag_retrieval_log_daily_tenant_day_idx
  ON public.rag_retrieval_log_daily (tenant_id, day DESC);

-- RLS — global reference data, service-role writes only, all callers
-- can SELECT (trend dashboards on the main app side).
ALTER TABLE public.rag_retrieval_log_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY rag_retrieval_log_daily_select ON public.rag_retrieval_log_daily
  FOR SELECT USING (TRUE);
-- No INSERT/UPDATE/DELETE policies — service-role bypasses RLS.

-- Aggregation function called by the §6.12 daily cron. Aggregates rows
-- older than p_cutoff into rag_retrieval_log_daily, idempotent: rerunning
-- on the same cutoff is a no-op (ON CONFLICT DO NOTHING).
CREATE OR REPLACE FUNCTION public.aggregate_retrieval_log_pre_cutoff(
  p_cutoff TIMESTAMPTZ
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO public.rag_retrieval_log_daily
    (tenant_id, day, outcome, request_count, avg_latency_ms, p95_latency_ms)
  SELECT
    tenant_id,
    DATE(created_at) AS day,
    outcome,
    COUNT(*)::INTEGER AS request_count,
    COALESCE(AVG(retrieval_latency_ms), 0)::INTEGER AS avg_latency_ms,
    COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY retrieval_latency_ms), 0)::INTEGER AS p95_latency_ms
  FROM public.rag_retrieval_log
  WHERE created_at < p_cutoff
  GROUP BY tenant_id, DATE(created_at), outcome
  ON CONFLICT (tenant_id, day, outcome) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.aggregate_retrieval_log_pre_cutoff(TIMESTAMPTZ) TO service_role;
