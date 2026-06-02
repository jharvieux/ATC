-- Security advisor (lints 0028/0029) — lock down internet-facing RPCs.
--
-- reconcile_promo_status(), count_promo_state_drift(), and
-- aggregate_retrieval_log_pre_cutoff(timestamptz) are SECURITY DEFINER
-- maintenance RPCs (created in 0016/0017). They GRANT EXECUTE to
-- service_role but were never REVOKEd from PUBLIC, so PostgreSQL's default
-- "EXECUTE to PUBLIC" left them callable by anon + authenticated over
-- /rest/v1/rpc. reconcile_promo_status UPDATEs public.knowledge_chunks
-- table-wide, so an unauthenticated caller could trigger an unauthorized
-- full-table reconcile (state change + DoS via repeated expensive calls).
--
-- Fix: revoke EXECUTE from PUBLIC and (defensively, in case Supabase's
-- ALTER DEFAULT PRIVILEGES granted them directly) from anon/authenticated.
-- The hourly/drift crons call these with the service-role key, which keeps
-- its explicit grant. Revoking a privilege a role only held via PUBLIC is
-- a harmless no-op notice, not an error.

REVOKE EXECUTE ON FUNCTION public.reconcile_promo_status() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reconcile_promo_status() TO service_role;

REVOKE EXECUTE ON FUNCTION public.count_promo_state_drift() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.count_promo_state_drift() TO service_role;

REVOKE EXECUTE ON FUNCTION public.aggregate_retrieval_log_pre_cutoff(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.aggregate_retrieval_log_pre_cutoff(TIMESTAMPTZ) TO service_role;
