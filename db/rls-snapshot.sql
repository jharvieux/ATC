-- AUTO-GENERATED RLS SNAPSHOT - DO NOT EDIT MANUALLY
-- Regenerate with: npx tsx scripts/rls-snapshot.ts > db/rls-snapshot.sql
-- Generated against schema: public

-- Tables with RLS enabled:
-- public.ai_kill_switch_state (rls_enabled)
-- public.anonymous_sessions (rls_enabled)
-- public.bookings (rls_enabled)
-- public.commissions (rls_enabled)
-- public.contact_relationships (rls_enabled)
-- public.contacts (rls_enabled)
-- public.conversations (rls_enabled)
-- public.customer_memories (rls_enabled)
-- public.escalation_topics (rls_enabled)
-- public.groups (rls_enabled)
-- public.host_adapters (rls_enabled)
-- public.host_booking_fee_configs (rls_enabled)
-- public.invitations (rls_enabled)
-- public.legal_consents (rls_enabled)
-- public.legal_documents (rls_enabled)
-- public.messages (rls_enabled)
-- public.payout_balances (rls_enabled)
-- public.payout_records (rls_enabled)
-- public.pending_rag_sync (rls_enabled)
-- public.persona_addendums (rls_enabled)
-- public.pipeline_stages (rls_enabled)
-- public.platform_revenue (rls_enabled)
-- public.platform_settings (rls_enabled)
-- public.quotes (rls_enabled)
-- public.stripe_webhook_events (rls_enabled)
-- public.sub_host_subcontractors (rls_enabled)
-- public.subcontractors (rls_enabled)
-- public.supervisor_review_queue (rls_enabled)
-- public.tenant_branding (rls_enabled)
-- public.tenant_host_configs (rls_enabled)
-- public.tenant_host_fee_overrides (rls_enabled)
-- public.tenant_inactivity_nudges (rls_enabled)
-- public.tenant_persona_overrides (rls_enabled)
-- public.tenants (rls_enabled)
-- public.user_consent_pending (rls_enabled)
-- public.user_data_export_requests (rls_enabled)
-- public.users (rls_enabled)
--
-- Tables with RLS disabled:
-- public.destination_images (rls_disabled)
-- public.destination_images_cache (rls_disabled)
-- public.email_log (rls_disabled)
-- public.reconciliation_review_queue (rls_disabled)
-- public.schema_migrations (rls_disabled)
-- public.tier_definitions (rls_disabled)

-- Policies:
-- TABLE: public.ai_kill_switch_state
CREATE POLICY "ai_kill_switch_state_select_policy" ON public.ai_kill_switch_state
  FOR SELECT TO PUBLIC
  USING (auth.uid() IS NOT NULL);

-- TABLE: public.anonymous_sessions
CREATE POLICY "anonymous_sessions_tenant_delete" ON public.anonymous_sessions
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "anonymous_sessions_tenant_insert" ON public.anonymous_sessions
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id));
CREATE POLICY "anonymous_sessions_tenant_select" ON public.anonymous_sessions
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "anonymous_sessions_tenant_update" ON public.anonymous_sessions
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id));

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

-- TABLE: public.contact_relationships
CREATE POLICY "contact_relationships_delete_policy" ON public.contact_relationships
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "contact_relationships_insert_policy" ON public.contact_relationships
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "contact_relationships_select_policy" ON public.contact_relationships
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "contact_relationships_update_policy" ON public.contact_relationships
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.contacts
CREATE POLICY "contacts_delete_policy" ON public.contacts
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "contacts_insert_policy" ON public.contacts
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "contacts_select_policy" ON public.contacts
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "contacts_update_policy" ON public.contacts
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

-- TABLE: public.customer_memories
CREATE POLICY "customer_memories_tenant_delete" ON public.customer_memories
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "customer_memories_tenant_insert" ON public.customer_memories
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id));
CREATE POLICY "customer_memories_tenant_select" ON public.customer_memories
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "customer_memories_tenant_update" ON public.customer_memories
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id));

-- TABLE: public.escalation_topics
CREATE POLICY "escalation_topics_delete_policy" ON public.escalation_topics
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "escalation_topics_insert_policy" ON public.escalation_topics
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "escalation_topics_select_policy" ON public.escalation_topics
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "escalation_topics_update_policy" ON public.escalation_topics
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.groups
CREATE POLICY "groups_delete" ON public.groups
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "groups_insert" ON public.groups
  FOR INSERT TO PUBLIC
  WITH CHECK ((tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE users.auth_user_id = auth.uid())));
CREATE POLICY "groups_select" ON public.groups
  FOR SELECT TO PUBLIC
  USING ((tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE users.auth_user_id = auth.uid())));
CREATE POLICY "groups_update" ON public.groups
  FOR UPDATE TO PUBLIC
  USING ((tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE users.auth_user_id = auth.uid())));

-- TABLE: public.host_adapters
CREATE POLICY "host_adapters_select_policy" ON public.host_adapters
  FOR SELECT TO PUBLIC
  USING (auth.role() = 'authenticated'::text OR auth.role() = 'service_role'::text);

-- TABLE: public.host_booking_fee_configs
CREATE POLICY "host_booking_fee_configs_select_policy" ON public.host_booking_fee_configs
  FOR SELECT TO PUBLIC
  USING (auth.role() = 'authenticated'::text OR auth.role() = 'service_role'::text);

-- TABLE: public.invitations
CREATE POLICY "invitations_delete" ON public.invitations
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "invitations_insert" ON public.invitations
  FOR INSERT TO PUBLIC
  WITH CHECK ((group_id IN ( SELECT groups.id
   FROM groups
  WHERE (groups.tenant_id IN ( SELECT users.tenant_id
           FROM users
          WHERE users.auth_user_id = auth.uid())))));
CREATE POLICY "invitations_select" ON public.invitations
  FOR SELECT TO PUBLIC
  USING ((group_id IN ( SELECT groups.id
   FROM groups
  WHERE (groups.tenant_id IN ( SELECT users.tenant_id
           FROM users
          WHERE users.auth_user_id = auth.uid())))));
CREATE POLICY "invitations_update" ON public.invitations
  FOR UPDATE TO PUBLIC
  USING ((group_id IN ( SELECT groups.id
   FROM groups
  WHERE (groups.tenant_id IN ( SELECT users.tenant_id
           FROM users
          WHERE users.auth_user_id = auth.uid())))));

-- TABLE: public.legal_consents
CREATE POLICY "legal_consents_delete" ON public.legal_consents
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "legal_consents_insert" ON public.legal_consents
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "legal_consents_select" ON public.legal_consents
  FOR SELECT TO PUBLIC
  USING (auth_user_id = auth.uid());
CREATE POLICY "legal_consents_update" ON public.legal_consents
  FOR UPDATE TO PUBLIC
  USING (false);

-- TABLE: public.legal_documents
CREATE POLICY "legal_documents_delete" ON public.legal_documents
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "legal_documents_insert" ON public.legal_documents
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "legal_documents_select" ON public.legal_documents
  FOR SELECT TO PUBLIC
  USING (auth.uid() IS NOT NULL);
CREATE POLICY "legal_documents_update" ON public.legal_documents
  FOR UPDATE TO PUBLIC
  USING (false);

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

-- TABLE: public.persona_addendums
CREATE POLICY "persona_addendums_delete" ON public.persona_addendums
  FOR DELETE TO PUBLIC
  USING ((tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE users.auth_user_id = auth.uid())));
CREATE POLICY "persona_addendums_insert" ON public.persona_addendums
  FOR INSERT TO PUBLIC
  WITH CHECK ((tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE users.auth_user_id = auth.uid())));
CREATE POLICY "persona_addendums_select" ON public.persona_addendums
  FOR SELECT TO PUBLIC
  USING ((tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE users.auth_user_id = auth.uid())));
CREATE POLICY "persona_addendums_update" ON public.persona_addendums
  FOR UPDATE TO PUBLIC
  USING ((tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE users.auth_user_id = auth.uid())));

-- TABLE: public.pipeline_stages
CREATE POLICY "pipeline_stages_delete_policy" ON public.pipeline_stages
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "pipeline_stages_insert_policy" ON public.pipeline_stages
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "pipeline_stages_select_policy" ON public.pipeline_stages
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "pipeline_stages_update_policy" ON public.pipeline_stages
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.platform_revenue
CREATE POLICY "platform_revenue_delete_policy" ON public.platform_revenue
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "platform_revenue_insert_policy" ON public.platform_revenue
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "platform_revenue_select_policy" ON public.platform_revenue
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "platform_revenue_update_policy" ON public.platform_revenue
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.platform_settings
CREATE POLICY "platform_settings_select_policy" ON public.platform_settings
  FOR SELECT TO PUBLIC
  USING (auth.uid() IS NOT NULL);

-- TABLE: public.quotes
CREATE POLICY "quotes_delete_policy" ON public.quotes
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "quotes_insert_policy" ON public.quotes
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "quotes_select_policy" ON public.quotes
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "quotes_update_policy" ON public.quotes
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.stripe_webhook_events
CREATE POLICY "stripe_webhook_events_select_policy" ON public.stripe_webhook_events
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_id IS NOT NULL);

-- TABLE: public.sub_host_subcontractors
CREATE POLICY "sub_host_subcontractors_delete_policy" ON public.sub_host_subcontractors
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "sub_host_subcontractors_insert_policy" ON public.sub_host_subcontractors
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "sub_host_subcontractors_select_policy" ON public.sub_host_subcontractors
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "sub_host_subcontractors_update_policy" ON public.sub_host_subcontractors
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

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

-- TABLE: public.tenant_branding
CREATE POLICY "tenant_branding_delete" ON public.tenant_branding
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "tenant_branding_insert" ON public.tenant_branding
  FOR INSERT TO PUBLIC
  WITH CHECK ((tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE users.auth_user_id = auth.uid())));
CREATE POLICY "tenant_branding_select" ON public.tenant_branding
  FOR SELECT TO PUBLIC
  USING ((tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE users.auth_user_id = auth.uid())));
CREATE POLICY "tenant_branding_update" ON public.tenant_branding
  FOR UPDATE TO PUBLIC
  USING ((tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE users.auth_user_id = auth.uid())));

-- TABLE: public.tenant_host_configs
CREATE POLICY "tenant_host_configs_delete_policy" ON public.tenant_host_configs
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "tenant_host_configs_insert_policy" ON public.tenant_host_configs
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "tenant_host_configs_select_policy" ON public.tenant_host_configs
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "tenant_host_configs_update_policy" ON public.tenant_host_configs
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.tenant_host_fee_overrides
CREATE POLICY "tenant_host_fee_overrides_delete_policy" ON public.tenant_host_fee_overrides
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "tenant_host_fee_overrides_insert_policy" ON public.tenant_host_fee_overrides
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "tenant_host_fee_overrides_select_policy" ON public.tenant_host_fee_overrides
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "tenant_host_fee_overrides_update_policy" ON public.tenant_host_fee_overrides
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.tenant_inactivity_nudges
CREATE POLICY "tenant_inactivity_nudges_delete" ON public.tenant_inactivity_nudges
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "tenant_inactivity_nudges_insert" ON public.tenant_inactivity_nudges
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "tenant_inactivity_nudges_select" ON public.tenant_inactivity_nudges
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "tenant_inactivity_nudges_update" ON public.tenant_inactivity_nudges
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.tenant_persona_overrides
CREATE POLICY "tenant_persona_overrides_delete" ON public.tenant_persona_overrides
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "tenant_persona_overrides_insert" ON public.tenant_persona_overrides
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "tenant_persona_overrides_select" ON public.tenant_persona_overrides
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "tenant_persona_overrides_update" ON public.tenant_persona_overrides
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

-- TABLE: public.user_consent_pending
CREATE POLICY "user_consent_pending_select" ON public.user_consent_pending
  FOR SELECT TO PUBLIC
  USING (auth_user_id = auth.uid());

-- TABLE: public.user_data_export_requests
CREATE POLICY "user_data_export_insert" ON public.user_data_export_requests
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_id = auth.uid());
CREATE POLICY "user_data_export_select" ON public.user_data_export_requests
  FOR SELECT TO PUBLIC
  USING (auth_user_id = auth.uid());

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

