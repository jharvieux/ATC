-- Security advisor (lint 0016) — attribution_rollup materialized view.
--
-- public.attribution_rollup is a materialized view of per-tenant aggregates
-- (it carries a tenant_id column). Materialized views cannot enforce RLS,
-- so its SELECT grant to anon/authenticated let any signed-in (or anon)
-- caller read every tenant's rows over /rest/v1 -- a latent cross-tenant
-- leak. The view is currently empty, so impact is latent today, but the
-- grant must be closed before it is populated.
--
-- It is registered in TENANT_SCOPED_TABLES, but no app path reads it through
-- tenantClient: the three reports routes (leads-by-source, source-funnel,
-- campaigns) query it via createServiceRoleClient() with an explicit
-- .eq("tenant_id", ...) filter. service_role keeps its grant (the REVOKE only
-- drops anon/authenticated), so this does not affect any app path. The nightly
-- refresh job is service-role too.

REVOKE SELECT ON public.attribution_rollup FROM anon, authenticated;
