-- Migration: explicit grants for service_role
-- Related to: D-032 (authenticated grants), BP04 (tenant resolver via PostgREST)
--
-- The atc-main Supabase project was provisioned without the standard
-- ALTER DEFAULT PRIVILEGES that grants table access to service_role. Without
-- explicit grants, PostgREST returns "permission denied for table X" even
-- when the JWT carries role = service_role.
--
-- service_role is NOT a PostgreSQL superuser (it has BYPASSRLS, not SUPERUSER),
-- so it requires the same explicit GRANT statements as authenticated/anon.
-- See also: D-032 for the analogous fix for the authenticated role.
--
-- Note: BYPASSRLS means service_role ignores RLS policies entirely, so these
-- grants carry real risk if misused. Only PostgREST paths that explicitly
-- construct a service-role client (tenant resolver, webhook handler) should
-- use the service-role JWT.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenants TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO service_role;
GRANT SELECT ON public.tier_definitions TO service_role;
