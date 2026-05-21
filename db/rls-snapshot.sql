-- AUTO-GENERATED RLS SNAPSHOT - DO NOT EDIT MANUALLY
-- Regenerate with: npx tsx scripts/rls-snapshot.ts > db/rls-snapshot.sql
-- Generated against schema: public

-- Tables with RLS enabled:
-- public.tenants (rls_enabled)
-- public.users (rls_enabled)
--
-- Tables with RLS disabled:
-- public.schema_migrations (rls_disabled)
-- public.tier_definitions (rls_disabled)

-- Policies:
-- TABLE: public.tenants
CREATE POLICY "tenants_select_policy" ON public.tenants
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(id));
CREATE POLICY "tenants_update_policy" ON public.tenants
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(id))
  WITH CHECK (auth_user_in_tenant(id) AND tenant_is_active(id));

-- TABLE: public.users
CREATE POLICY "users_delete_policy" ON public.users
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "users_insert_policy" ON public.users
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "users_select_policy" ON public.users
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "users_update_policy" ON public.users
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

