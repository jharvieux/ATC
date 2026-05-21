-- AUTO-GENERATED RLS SNAPSHOT - DO NOT EDIT MANUALLY
-- Regenerate with: npx tsx scripts/rls-snapshot.ts > db/rls-snapshot.sql
-- Generated against schema: public

-- Tables with RLS enabled:
-- public.bookings (rls_enabled)
-- public.commissions (rls_enabled)
-- public.conversations (rls_enabled)
-- public.messages (rls_enabled)
-- public.payout_balances (rls_enabled)
-- public.payout_records (rls_enabled)
-- public.stripe_webhook_events (rls_enabled)
-- public.subcontractors (rls_enabled)
-- public.tenants (rls_enabled)
-- public.users (rls_enabled)
--
-- Tables with RLS disabled:
-- public.schema_migrations (rls_disabled)
-- public.tier_definitions (rls_disabled)

-- Policies:
-- TABLE: public.bookings
CREATE POLICY "bookings_delete_policy" ON public.bookings
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "bookings_insert_policy" ON public.bookings
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "bookings_select_policy" ON public.bookings
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "bookings_update_policy" ON public.bookings
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.commissions
CREATE POLICY "commissions_delete_policy" ON public.commissions
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "commissions_insert_policy" ON public.commissions
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "commissions_select_policy" ON public.commissions
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "commissions_update_policy" ON public.commissions
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.conversations
CREATE POLICY "conversations_delete_policy" ON public.conversations
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "conversations_insert_policy" ON public.conversations
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "conversations_select_policy" ON public.conversations
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "conversations_update_policy" ON public.conversations
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.messages
CREATE POLICY "messages_delete_policy" ON public.messages
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "messages_insert_policy" ON public.messages
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "messages_select_policy" ON public.messages
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "messages_update_policy" ON public.messages
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.payout_balances
CREATE POLICY "payout_balances_delete_policy" ON public.payout_balances
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "payout_balances_insert_policy" ON public.payout_balances
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "payout_balances_select_policy" ON public.payout_balances
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "payout_balances_update_policy" ON public.payout_balances
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.payout_records
CREATE POLICY "payout_records_delete_policy" ON public.payout_records
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "payout_records_insert_policy" ON public.payout_records
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "payout_records_select_policy" ON public.payout_records
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "payout_records_update_policy" ON public.payout_records
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.stripe_webhook_events
CREATE POLICY "stripe_webhook_events_select_policy" ON public.stripe_webhook_events
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_id IS NOT NULL);

-- TABLE: public.subcontractors
CREATE POLICY "subcontractors_delete_policy" ON public.subcontractors
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "subcontractors_insert_policy" ON public.subcontractors
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "subcontractors_select_policy" ON public.subcontractors
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "subcontractors_update_policy" ON public.subcontractors
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

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

