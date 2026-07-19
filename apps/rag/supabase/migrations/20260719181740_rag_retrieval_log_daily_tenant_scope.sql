-- Migration: rag_retrieval_log_daily_tenant_scope
-- Version:   20260719181740
-- Generated: 2026-07-19T18:17:41Z by scripts/new-migration.sh
-- Branch:    feature/sweep-rag-db-2005
-- Worktree:  agent-a3a10eb007fa7bbec
--
-- #2005 — rag_retrieval_log_daily SELECT policy was USING (TRUE): the RLS
-- layer applied no tenant predicate, so isolation of per-tenant daily usage
-- metrics rested entirely on the absence of a client (anon/authenticated)
-- grant. Add the tenant predicate so a leak needs two failures, not one —
-- matching the shape already used on rag_media_assets (each row here is
-- tenant-owned; there is no 'global' scope, so no scope disjunct).
--
-- The predicate is written in the init-plan-optimized `(select current_setting(...))`
-- form (per the same #2008 hardening applied to rag_media_assets in the sibling
-- migration) so this new policy doesn't itself trip an auth_rls_initplan warning.
--
-- No behavior change for the writers/readers: the §6.12 aggregation cron and
-- any dashboard read run under service_role, which bypasses RLS. The RAG
-- backend grants nothing to client roles, so no caller loses access today.
--
-- Policy change → RLS snapshot regenerated in the same PR (db/rls-snapshot-rag.sql).

DROP POLICY IF EXISTS rag_retrieval_log_daily_select ON public.rag_retrieval_log_daily;
CREATE POLICY rag_retrieval_log_daily_select ON public.rag_retrieval_log_daily
  FOR SELECT USING (
    tenant_id::text = (SELECT current_setting('request.jwt.claim.tenant_id', true))
  );
