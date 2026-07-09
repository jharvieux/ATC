-- Migration: ai_call_log_cost_rollup_rpc
-- Version:   20260722000013
-- Generated: 2026-07-09 by scripts/new-migration.sh
-- Branch:    feature/sweep-db-misc-1698
-- Worktree:  agent-a79f0cb75f2288c77
--
-- #1698 (#1588 follow-up) — DB-side aggregation for the resource-utilization
-- dashboard. The route previously paged every ai_call_log row in the 30-day
-- window (up to ~2000 round-trips at target scale) and aggregated in JS. These
-- two functions collapse that to two cheap GROUP BY aggregates computed in
-- Postgres: a daily cost rollup and a per-vendor/model rollup. The route still
-- merges the RAG embedding rows (from a separate Supabase project) in JS, so
-- these cover main's ai_call_log only.
--
-- Daily bucketing uses (created_at AT TIME ZONE 'UTC')::date to match the JS
-- buildDailyArray bucketing, which keys on the UTC calendar date.
--
-- SECURITY DEFINER + empty search_path (every object schema-qualified) so the
-- service-role caller (the route's platform-admin client) runs the aggregate;
-- EXECUTE revoked from PUBLIC and granted only to service_role. The existing
-- ai_call_log_created_idx (created_at) covers the range scan — no new index is
-- added for ai_call_log (the (created_at, id) index #1714 listed for the old
-- paginated read is intentionally omitted, since this migration removes that
-- read in the same PR).

CREATE OR REPLACE FUNCTION public.ai_call_log_daily_cost_rollup(
  p_from TIMESTAMPTZ,
  p_to   TIMESTAMPTZ
) RETURNS TABLE (day DATE, cost_cents BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (created_at AT TIME ZONE 'UTC')::date AS day,
         COALESCE(SUM(cost_estimate_cents), 0)::bigint AS cost_cents
  FROM   public.ai_call_log
  WHERE  created_at >= p_from
    AND  created_at <  p_to
  GROUP  BY (created_at AT TIME ZONE 'UTC')::date;
$$;

REVOKE EXECUTE ON FUNCTION public.ai_call_log_daily_cost_rollup(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.ai_call_log_daily_cost_rollup(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

COMMENT ON FUNCTION public.ai_call_log_daily_cost_rollup(TIMESTAMPTZ, TIMESTAMPTZ) IS
  '#1698: daily (UTC) cost rollup of ai_call_log over [p_from, p_to) for the resource-utilization dashboard. SECURITY DEFINER, service_role only.';

CREATE OR REPLACE FUNCTION public.ai_call_log_model_rollup(
  p_from TIMESTAMPTZ,
  p_to   TIMESTAMPTZ
) RETURNS TABLE (
  vendor        TEXT,
  model         TEXT,
  call_count    BIGINT,
  input_tokens  BIGINT,
  output_tokens BIGINT,
  cost_cents    BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT vendor,
         model,
         COUNT(*)::bigint                          AS call_count,
         COALESCE(SUM(input_tokens), 0)::bigint    AS input_tokens,
         COALESCE(SUM(output_tokens), 0)::bigint   AS output_tokens,
         COALESCE(SUM(cost_estimate_cents), 0)::bigint AS cost_cents
  FROM   public.ai_call_log
  WHERE  created_at >= p_from
    AND  created_at <  p_to
  GROUP  BY vendor, model;
$$;

REVOKE EXECUTE ON FUNCTION public.ai_call_log_model_rollup(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.ai_call_log_model_rollup(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

COMMENT ON FUNCTION public.ai_call_log_model_rollup(TIMESTAMPTZ, TIMESTAMPTZ) IS
  '#1698: per-vendor/model rollup of ai_call_log over [p_from, p_to) for the resource-utilization dashboard. SECURITY DEFINER, service_role only.';
