-- Migration: RLS policies for tenants and users
-- Spec refs: §5.1, §5.1.2 (required RLS policy coverage)
--
-- Enables RLS and creates policies. The users table gets the full
-- 4-policy minimum coverage set per §5.1.2. The tenants table is a
-- documented deviation — only SELECT and UPDATE policies are exposed
-- to the authenticated role; INSERT goes through service-role admin
-- paths and DELETE is structurally blocked by the §5.1.X trigger.

-- ---------------------------------------------------------------------------
-- tenants
--
-- Deviation from §5.1.2 minimum coverage: no INSERT or DELETE policy
-- for the authenticated role.
--   - Tenant creation is a platform-admin / signup flow that runs under
--     the service role, which bypasses RLS by definition.
--   - Hard-delete is blocked by the prevent_tenant_hard_delete trigger
--     from migration 0001; soft-termination uses UPDATE status='terminated'.
-- Documented in db/rls-snapshot.sql per §30.8.
-- ---------------------------------------------------------------------------

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenants_select_policy ON public.tenants
  FOR SELECT
  USING (public.auth_user_in_tenant(id));

CREATE POLICY tenants_update_policy ON public.tenants
  FOR UPDATE
  USING (public.auth_user_in_tenant(id))
  WITH CHECK (
    public.auth_user_in_tenant(id)
    AND public.tenant_is_active(id)
  );

COMMENT ON TABLE public.tenants IS
  'Tenancy root table. RLS deviation: SELECT + UPDATE only for authenticated role. INSERT runs under service role; DELETE blocked by prevent_tenant_hard_delete trigger (§5.1.X). See db/rls-snapshot.sql per §30.8.';

-- ---------------------------------------------------------------------------
-- users — full 4-policy minimum coverage per §5.1.2
-- ---------------------------------------------------------------------------

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_select_policy ON public.users
  FOR SELECT
  USING (public.auth_user_in_tenant(tenant_id));

CREATE POLICY users_insert_policy ON public.users
  FOR INSERT
  WITH CHECK (
    public.auth_user_in_tenant(tenant_id)
    AND public.tenant_is_active(tenant_id)
  );

CREATE POLICY users_update_policy ON public.users
  FOR UPDATE
  USING (public.auth_user_in_tenant(tenant_id))
  WITH CHECK (
    public.auth_user_in_tenant(tenant_id)
    AND public.tenant_is_active(tenant_id)
  );

CREATE POLICY users_delete_policy ON public.users
  FOR DELETE
  USING (
    public.auth_user_in_tenant(tenant_id)
    AND public.tenant_is_active(tenant_id)
  );
