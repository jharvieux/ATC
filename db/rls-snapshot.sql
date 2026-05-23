-- AUTO-GENERATED RLS SNAPSHOT - DO NOT EDIT MANUALLY
-- Regenerate with: npx tsx scripts/rls-snapshot.ts > db/rls-snapshot.sql
-- Generated against schema: public

-- Tables with RLS enabled:
-- public.ai_kill_switch_state (rls_enabled)
-- public.anonymous_chat_counters (rls_enabled)
-- public.anonymous_sessions (rls_enabled)
-- public.audit_log (rls_enabled)
-- public.auth_attempts (rls_enabled)
-- public.booking_options (rls_enabled)
-- public.booking_passengers (rls_enabled)
-- public.bookings (rls_enabled)
-- public.ccpa_deletion_executions (rls_enabled)
-- public.commissions (rls_enabled)
-- public.complaints (rls_enabled)
-- public.contact_relationships (rls_enabled)
-- public.contacts (rls_enabled)
-- public.conversations (rls_enabled)
-- public.customer_chat_counters (rls_enabled)
-- public.customer_chat_tenant_overrides (rls_enabled)
-- public.customer_memories (rls_enabled)
-- public.email_log (rls_enabled)
-- public.email_suppressions (rls_enabled)
-- public.escalation_topics (rls_enabled)
-- public.forensics_log (rls_enabled)
-- public.forum_messages (rls_enabled)
-- public.forum_reactions (rls_enabled)
-- public.forum_strikes (rls_enabled)
-- public.forum_threads (rls_enabled)
-- public.forum_user_state (rls_enabled)
-- public.forums (rls_enabled)
-- public.groups (rls_enabled)
-- public.host_adapters (rls_enabled)
-- public.host_booking_fee_configs (rls_enabled)
-- public.invitations (rls_enabled)
-- public.legal_consents (rls_enabled)
-- public.legal_documents (rls_enabled)
-- public.messages (rls_enabled)
-- public.notifications (rls_enabled)
-- public.payout_balances (rls_enabled)
-- public.payout_records (rls_enabled)
-- public.pending_rag_sync (rls_enabled)
-- public.persona_addendums (rls_enabled)
-- public.pipeline_stages (rls_enabled)
-- public.platform_revenue (rls_enabled)
-- public.platform_settings (rls_enabled)
-- public.port_info_chunks (rls_enabled)
-- public.pre_cruise_email_content (rls_enabled)
-- public.quotes (rls_enabled)
-- public.rag_global_promotions (rls_enabled)
-- public.rag_submissions (rls_enabled)
-- public.security_incidents (rls_enabled)
-- public.staging_cron_skips (rls_enabled)
-- public.stripe_webhook_events (rls_enabled)
-- public.sub_host_subcontractors (rls_enabled)
-- public.subcontractors (rls_enabled)
-- public.supervisor_review_queue (rls_enabled)
-- public.tenant_branding (rls_enabled)
-- public.tenant_host_configs (rls_enabled)
-- public.tenant_host_fee_overrides (rls_enabled)
-- public.tenant_inactivity_nudges (rls_enabled)
-- public.tenant_persona_overrides (rls_enabled)
-- public.tenant_settings (rls_enabled)
-- public.tenants (rls_enabled)
-- public.user_consent_pending (rls_enabled)
-- public.user_data_export_requests (rls_enabled)
-- public.users (rls_enabled)
--
-- Tables with RLS disabled:
-- public.destination_images (rls_disabled)
-- public.destination_images_cache (rls_disabled)
-- public.reconciliation_review_queue (rls_disabled)
-- public.schema_migrations (rls_disabled)
-- public.tier_definitions (rls_disabled)

-- Policies:
-- TABLE: public.ai_kill_switch_state
CREATE POLICY "ai_kill_switch_state_select_policy" ON public.ai_kill_switch_state
  FOR SELECT TO PUBLIC
  USING (auth.uid() IS NOT NULL);

-- TABLE: public.anonymous_chat_counters
CREATE POLICY "anonymous_chat_counters_delete_service" ON public.anonymous_chat_counters
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "anonymous_chat_counters_insert_service" ON public.anonymous_chat_counters
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "anonymous_chat_counters_select_service" ON public.anonymous_chat_counters
  FOR SELECT TO PUBLIC
  USING (false);
CREATE POLICY "anonymous_chat_counters_update_service" ON public.anonymous_chat_counters
  FOR UPDATE TO PUBLIC
  USING (false);

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

-- TABLE: public.audit_log
CREATE POLICY "audit_log_delete_service" ON public.audit_log
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "audit_log_insert_service" ON public.audit_log
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "audit_log_select_in_tenant" ON public.audit_log
  FOR SELECT TO PUBLIC
  USING (auth.uid() IS NOT NULL AND tenant_id IS NOT NULL AND auth_user_in_tenant(tenant_id));
CREATE POLICY "audit_log_update_service" ON public.audit_log
  FOR UPDATE TO PUBLIC
  USING (false);

-- TABLE: public.auth_attempts
CREATE POLICY "auth_attempts_delete_service" ON public.auth_attempts
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "auth_attempts_insert_service" ON public.auth_attempts
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "auth_attempts_select_service" ON public.auth_attempts
  FOR SELECT TO PUBLIC
  USING (false);
CREATE POLICY "auth_attempts_update_service" ON public.auth_attempts
  FOR UPDATE TO PUBLIC
  USING (false);

-- TABLE: public.booking_options
CREATE POLICY "booking_options_delete" ON public.booking_options
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "booking_options_insert" ON public.booking_options
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "booking_options_select" ON public.booking_options
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "booking_options_update" ON public.booking_options
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.booking_passengers
CREATE POLICY "booking_passengers_delete" ON public.booking_passengers
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "booking_passengers_insert" ON public.booking_passengers
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "booking_passengers_select" ON public.booking_passengers
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "booking_passengers_update" ON public.booking_passengers
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

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

-- TABLE: public.ccpa_deletion_executions
CREATE POLICY "ccpa_executions_delete_service" ON public.ccpa_deletion_executions
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "ccpa_executions_insert_service" ON public.ccpa_deletion_executions
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "ccpa_executions_select" ON public.ccpa_deletion_executions
  FOR SELECT TO PUBLIC
  USING (tenant_id IS NOT NULL AND auth_user_in_tenant(tenant_id));
CREATE POLICY "ccpa_executions_update_service" ON public.ccpa_deletion_executions
  FOR UPDATE TO PUBLIC
  USING (false);

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

-- TABLE: public.complaints
CREATE POLICY "complaints_delete_service" ON public.complaints
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "complaints_insert_in_tenant" ON public.complaints
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "complaints_select_in_tenant" ON public.complaints
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "complaints_update_service" ON public.complaints
  FOR UPDATE TO PUBLIC
  USING (false);

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

-- TABLE: public.customer_chat_counters
CREATE POLICY "customer_chat_counters_delete_service" ON public.customer_chat_counters
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "customer_chat_counters_insert_service" ON public.customer_chat_counters
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "customer_chat_counters_select_own" ON public.customer_chat_counters
  FOR SELECT TO PUBLIC
  USING (user_id = auth.uid());
CREATE POLICY "customer_chat_counters_update_service" ON public.customer_chat_counters
  FOR UPDATE TO PUBLIC
  USING (false);

-- TABLE: public.customer_chat_tenant_overrides
CREATE POLICY "ccto_delete_service" ON public.customer_chat_tenant_overrides
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "ccto_insert_service" ON public.customer_chat_tenant_overrides
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "ccto_select_in_tenant" ON public.customer_chat_tenant_overrides
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "ccto_update_service" ON public.customer_chat_tenant_overrides
  FOR UPDATE TO PUBLIC
  USING (false);

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

-- TABLE: public.email_log
CREATE POLICY "email_log_insert_service" ON public.email_log
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "email_log_select" ON public.email_log
  FOR SELECT TO PUBLIC
  USING (auth.uid() IS NOT NULL AND (tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE users.id = auth.uid())));
CREATE POLICY "email_log_update_service" ON public.email_log
  FOR UPDATE TO PUBLIC
  USING (false);

-- TABLE: public.email_suppressions
CREATE POLICY "email_suppressions_delete_service" ON public.email_suppressions
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "email_suppressions_insert_service" ON public.email_suppressions
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "email_suppressions_select" ON public.email_suppressions
  FOR SELECT TO PUBLIC
  USING (auth.uid() IS NOT NULL AND (tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE users.id = auth.uid())));
CREATE POLICY "email_suppressions_update_service" ON public.email_suppressions
  FOR UPDATE TO PUBLIC
  USING (false);

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

-- TABLE: public.forensics_log
CREATE POLICY "forensics_log_delete_service" ON public.forensics_log
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "forensics_log_insert_service" ON public.forensics_log
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "forensics_log_select_service" ON public.forensics_log
  FOR SELECT TO PUBLIC
  USING (false);
CREATE POLICY "forensics_log_update_service" ON public.forensics_log
  FOR UPDATE TO PUBLIC
  USING (false);

-- TABLE: public.forum_messages
CREATE POLICY "forum_messages_delete" ON public.forum_messages
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "forum_messages_insert" ON public.forum_messages
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "forum_messages_select" ON public.forum_messages
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND (status = 'visible'::text OR (user_id IN ( SELECT users.id
   FROM users
  WHERE users.auth_user_id = auth.uid()))));
CREATE POLICY "forum_messages_update" ON public.forum_messages
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id));

-- TABLE: public.forum_reactions
CREATE POLICY "forum_reactions_delete" ON public.forum_reactions
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id) AND (user_id IN ( SELECT users.id
   FROM users
  WHERE users.auth_user_id = auth.uid())));
CREATE POLICY "forum_reactions_insert" ON public.forum_reactions
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "forum_reactions_select" ON public.forum_reactions
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "forum_reactions_update" ON public.forum_reactions
  FOR UPDATE TO PUBLIC
  USING (false);

-- TABLE: public.forum_strikes
CREATE POLICY "forum_strikes_delete" ON public.forum_strikes
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "forum_strikes_insert" ON public.forum_strikes
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id));
CREATE POLICY "forum_strikes_select" ON public.forum_strikes
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "forum_strikes_update" ON public.forum_strikes
  FOR UPDATE TO PUBLIC
  USING (false);

-- TABLE: public.forum_threads
CREATE POLICY "forum_threads_delete" ON public.forum_threads
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "forum_threads_insert" ON public.forum_threads
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "forum_threads_select" ON public.forum_threads
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "forum_threads_update" ON public.forum_threads
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.forum_user_state
CREATE POLICY "forum_user_state_delete" ON public.forum_user_state
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "forum_user_state_insert" ON public.forum_user_state
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id));
CREATE POLICY "forum_user_state_select" ON public.forum_user_state
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "forum_user_state_update" ON public.forum_user_state
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id));

-- TABLE: public.forums
CREATE POLICY "forums_delete" ON public.forums
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "forums_insert" ON public.forums
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "forums_select" ON public.forums
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "forums_update" ON public.forums
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

-- TABLE: public.notifications
CREATE POLICY "notifications_delete_service" ON public.notifications
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "notifications_insert_service" ON public.notifications
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "notifications_own_select" ON public.notifications
  FOR SELECT TO PUBLIC
  USING (user_id = auth.uid());
CREATE POLICY "notifications_own_update" ON public.notifications
  FOR UPDATE TO PUBLIC
  USING (user_id = auth.uid());

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

-- TABLE: public.port_info_chunks
CREATE POLICY "port_info_insert_service" ON public.port_info_chunks
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "port_info_read" ON public.port_info_chunks
  FOR SELECT TO PUBLIC
  USING (auth.uid() IS NOT NULL);
CREATE POLICY "port_info_update_service" ON public.port_info_chunks
  FOR UPDATE TO PUBLIC
  USING (false);

-- TABLE: public.pre_cruise_email_content
CREATE POLICY "pce_content_delete_service" ON public.pre_cruise_email_content
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "pce_content_insert_service" ON public.pre_cruise_email_content
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "pce_content_select" ON public.pre_cruise_email_content
  FOR SELECT TO PUBLIC
  USING (auth.uid() IS NOT NULL AND (tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE users.id = auth.uid())));
CREATE POLICY "pce_content_update_service" ON public.pre_cruise_email_content
  FOR UPDATE TO PUBLIC
  USING (false);

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

-- TABLE: public.rag_global_promotions
CREATE POLICY "rag_global_promotions_delete_policy" ON public.rag_global_promotions
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "rag_global_promotions_insert_policy" ON public.rag_global_promotions
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "rag_global_promotions_select_policy" ON public.rag_global_promotions
  FOR SELECT TO PUBLIC
  USING ((submission_id IN ( SELECT rag_submissions.id
   FROM rag_submissions
  WHERE auth_user_in_tenant(rag_submissions.tenant_id))));
CREATE POLICY "rag_global_promotions_update_policy" ON public.rag_global_promotions
  FOR UPDATE TO PUBLIC
  USING (false)
  WITH CHECK (false);

-- TABLE: public.rag_submissions
CREATE POLICY "rag_submissions_delete_policy" ON public.rag_submissions
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "rag_submissions_insert_policy" ON public.rag_submissions
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "rag_submissions_select_policy" ON public.rag_submissions
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "rag_submissions_update_policy" ON public.rag_submissions
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.security_incidents
CREATE POLICY "security_incidents_delete_service" ON public.security_incidents
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "security_incidents_insert_service" ON public.security_incidents
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "security_incidents_select_service" ON public.security_incidents
  FOR SELECT TO PUBLIC
  USING (false);
CREATE POLICY "security_incidents_update_service" ON public.security_incidents
  FOR UPDATE TO PUBLIC
  USING (false);

-- TABLE: public.staging_cron_skips
CREATE POLICY "staging_cron_skips_delete_service" ON public.staging_cron_skips
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "staging_cron_skips_insert_service" ON public.staging_cron_skips
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "staging_cron_skips_select_service" ON public.staging_cron_skips
  FOR SELECT TO PUBLIC
  USING (false);
CREATE POLICY "staging_cron_skips_update_service" ON public.staging_cron_skips
  FOR UPDATE TO PUBLIC
  USING (false);

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

-- TABLE: public.tenant_settings
CREATE POLICY "tenant_settings_delete_policy" ON public.tenant_settings
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "tenant_settings_insert_policy" ON public.tenant_settings
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "tenant_settings_select_policy" ON public.tenant_settings
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "tenant_settings_update_policy" ON public.tenant_settings
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

