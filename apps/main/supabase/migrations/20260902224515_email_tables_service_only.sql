-- Migration: email_tables_service_only
-- Version:   20260902224515
-- Generated: 2026-09-02T22:45:15Z by scripts/new-migration.sh
-- Branch:    feature/sweep-email-access-2119
-- Worktree:  atc-sweep-email-access-2119
--
-- Make the delivery audit and suppression registry service-role-only. No UI,
-- authenticated Data API client, or user-facing route reads either table
-- directly; legitimate workflows already run through server-gated service
-- clients. False policies plus revoked grants keep the Data API fail-closed.
--
-- Rollback: restore the tenant-member SELECT policies and authenticated SELECT
-- grants from 20260715000000_rls_initplan_wrap_auth.sql only if a reviewed
-- tenant-facing raw-table product workflow is introduced.

DROP POLICY IF EXISTS email_log_select ON public.email_log;
DROP POLICY IF EXISTS email_log_select_service ON public.email_log;
CREATE POLICY email_log_select_service ON public.email_log
  FOR SELECT USING (FALSE);

DROP POLICY IF EXISTS email_log_delete_service ON public.email_log;
CREATE POLICY email_log_delete_service ON public.email_log
  FOR DELETE USING (FALSE);

DROP POLICY IF EXISTS email_suppressions_select ON public.email_suppressions;
DROP POLICY IF EXISTS email_suppressions_select_service ON public.email_suppressions;
CREATE POLICY email_suppressions_select_service ON public.email_suppressions
  FOR SELECT USING (FALSE);

REVOKE ALL PRIVILEGES ON TABLE public.email_log
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.email_suppressions
  FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_log TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_suppressions TO service_role;

COMMENT ON TABLE public.email_log IS
  'Service-role-only tenant-attributed email delivery audit and rate-limit log. Data API access for PUBLIC, anon, and authenticated is denied.';
COMMENT ON COLUMN public.email_log.tenant_id IS
  'Owning tenant; NOT NULL. Platform-originated sends use the platform sentinel tenant UUID rather than NULL.';
COMMENT ON TABLE public.email_suppressions IS
  'Service-role-only tenant-scoped email suppression registry. Customer unsubscribe links write through the signed-token server route.';
COMMENT ON COLUMN public.email_suppressions.tenant_id IS
  'Owning tenant; NOT NULL. Every suppression is isolated by tenant_id.';
