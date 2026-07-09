-- Migration: ai_batch_requests_rollup_rpc
-- Version:   20260722000015
-- Generated: 2026-07-09T19:52:22Z by scripts/new-migration.sh
-- Branch:    feature/sweep-platform2-1741
-- Worktree:  agent-aa35662faeadbc93a
--
-- #1743 — reconcile.ts's job-level rollup (total_cost_cents/total_*_tokens,
-- #1697) did `.select(...).eq(batch_job_id).eq(status,'completed').limit(
-- job.request_count)`. PostgREST's db-max-rows setting (~1000 on Supabase)
-- silently caps returned rows regardless of the requested .limit(), so a job
-- whose completed-row count exceeds that cap would under-report its rollup
-- once MAX_REQUESTS_PER_BATCH (flush.ts) is raised past ~1000 — the same
-- failure mode #1697 fixed, with a different trigger. Aggregating with SUM()
-- server-side removes the row cap entirely: no rows are ever returned to the
-- client, only the aggregate.
--
-- This also subsumes #1749 (find-existing branch of adoptStrandedBatches
-- never revises request_count upward when a batch's stranded rows straddle
-- the adopt sweep's row limit): request_count is no longer read by the
-- rollup at all, so a stale request_count can no longer under-cap it.
--
-- SECURITY DEFINER + empty search_path (every object schema-qualified) so
-- the service-role reconcile cron can call it under RLS; EXECUTE revoked
-- from PUBLIC and granted only to service_role, matching
-- increment_tenant_ai_cost (20260627000000) and the ai_call_log rollup RPCs
-- (20260722000013).

CREATE OR REPLACE FUNCTION public.ai_batch_requests_rollup(
  p_batch_job_id UUID
) RETURNS TABLE (
  total_cost_cents    BIGINT,
  total_input_tokens  BIGINT,
  total_output_tokens BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    COALESCE(SUM(cost_cents), 0)::bigint AS total_cost_cents,
    COALESCE(SUM((result_metadata->>'input_tokens')::bigint), 0)::bigint AS total_input_tokens,
    COALESCE(SUM((result_metadata->>'output_tokens')::bigint), 0)::bigint AS total_output_tokens
  FROM public.ai_batch_requests
  WHERE batch_job_id = p_batch_job_id
    AND status = 'completed';
$$;

REVOKE EXECUTE ON FUNCTION public.ai_batch_requests_rollup(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.ai_batch_requests_rollup(UUID) TO service_role;

COMMENT ON FUNCTION public.ai_batch_requests_rollup(UUID) IS
  '#1743: DB-side SUM rollup of ai_batch_requests.cost_cents/result_metadata tokens for a completed batch job, replacing a row-capped .select().limit() aggregate in reconcile.ts. SECURITY DEFINER, service_role only.';
