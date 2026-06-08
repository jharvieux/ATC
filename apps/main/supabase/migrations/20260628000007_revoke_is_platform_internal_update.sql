-- Revoke UPDATE on is_platform_internal from authenticated role.
--
-- is_platform_internal=true exempts a tenant from the AI cost hard gate and
-- other billing enforcement. Without column-level protection any tenant admin
-- with a valid JWT can flip their own row:
--   UPDATE tenants SET is_platform_internal = true WHERE id = '<their-id>'
-- — passes the existing row-level policy (auth_user_in_tenant) and grants
-- permanent AI cost exemption. Column-level REVOKE closes this at the DB layer
-- regardless of how the UPDATE is submitted.

REVOKE UPDATE (is_platform_internal) ON public.tenants FROM authenticated;
