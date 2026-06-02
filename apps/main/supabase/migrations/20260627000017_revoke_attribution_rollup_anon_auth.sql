-- Security advisor (lint 0016) — attribution_rollup materialized view.
--
-- public.attribution_rollup is a materialized view of per-tenant aggregates
-- (it carries a tenant_id column). Materialized views cannot enforce RLS,
-- so its SELECT grant to anon/authenticated let any signed-in (or anon)
-- caller read every tenant's rows over /rest/v1 -- a latent cross-tenant
-- leak. The view is currently empty, so impact is latent today, but the
-- grant must be closed before it is populated.
--
-- Every application read goes through the service-role client (the reports
-- routes use createServiceRoleClient; the view is registered
-- PLATFORM_READABLE for tenantClient's service-role passthrough), so this
-- revoke does not affect any app path. The refresh job is service-role too.

REVOKE SELECT ON public.attribution_rollup FROM anon, authenticated;
