-- AUTO-GENERATED RLS SNAPSHOT - DO NOT EDIT MANUALLY
-- Target: main
-- Regenerate with: npx tsx scripts/rls-snapshot.ts --target=main > db/rls-snapshot-main.sql
-- Generated against schema: public

-- Tables with RLS enabled:
-- public.abuse_recompute_drift_log (rls_enabled)
-- public.abuse_signals (rls_enabled)
-- public.ai_batch_jobs (rls_enabled)
-- public.ai_batch_requests (rls_enabled)
-- public.ai_call_log (rls_enabled)
-- public.ai_kill_switch_state (rls_enabled)
-- public.ai_tool_calls (rls_enabled)
-- public.anonymous_chat_counters (rls_enabled)
-- public.anonymous_sessions (rls_enabled)
-- public.attribution_touches (rls_enabled)
-- public.audit_log (rls_enabled)
-- public.auth_attempts (rls_enabled)
-- public.booking_line_items (rls_enabled)
-- public.booking_options (rls_enabled)
-- public.booking_passengers (rls_enabled)
-- public.bookings (rls_enabled)
-- public.bug_submissions (rls_enabled)
-- public.campaigns (rls_enabled)
-- public.canonical_match_reviews (rls_enabled)
-- public.ccpa_deletion_executions (rls_enabled)
-- public.commissions (rls_enabled)
-- public.complaints (rls_enabled)
-- public.contact_imports (rls_enabled)
-- public.contact_relationships (rls_enabled)
-- public.contacts (rls_enabled)
-- public.conversations (rls_enabled)
-- public.cruise_line_aliases (rls_enabled)
-- public.cruise_lines (rls_enabled)
-- public.cruise_ship_aliases (rls_enabled)
-- public.cruise_ships (rls_enabled)
-- public.customer_bug_submission_counters (rls_enabled)
-- public.customer_chat_counters (rls_enabled)
-- public.customer_chat_tenant_overrides (rls_enabled)
-- public.customer_memories (rls_enabled)
-- public.email_log (rls_enabled)
-- public.email_suppressions (rls_enabled)
-- public.escalation_topics (rls_enabled)
-- public.feature_requests (rls_enabled)
-- public.forensics_log (rls_enabled)
-- public.forum_messages (rls_enabled)
-- public.forum_reactions (rls_enabled)
-- public.forum_strikes (rls_enabled)
-- public.forum_threads (rls_enabled)
-- public.forum_user_state (rls_enabled)
-- public.forums (rls_enabled)
-- public.general_pricing_ranges (rls_enabled)
-- public.gmail_inbound_messages (rls_enabled)
-- public.gmail_oauth_tokens (rls_enabled)
-- public.group_invite_pending_approval (rls_enabled)
-- public.groups (rls_enabled)
-- public.help_doc_versions (rls_enabled)
-- public.help_sessions (rls_enabled)
-- public.host_adapters (rls_enabled)
-- public.host_booking_fee_configs (rls_enabled)
-- public.import_queue (rls_enabled)
-- public.invitations (rls_enabled)
-- public.legal_consents (rls_enabled)
-- public.legal_documents (rls_enabled)
-- public.messages (rls_enabled)
-- public.news_articles (rls_enabled)
-- public.news_feeds (rls_enabled)
-- public.notifications (rls_enabled)
-- public.payout_balances (rls_enabled)
-- public.payout_records (rls_enabled)
-- public.pending_rag_sync (rls_enabled)
-- public.persona_addendums (rls_enabled)
-- public.persona_safety_config (rls_enabled)
-- public.personas (rls_enabled)
-- public.pipeline_stages (rls_enabled)
-- public.platform_admins (rls_enabled)
-- public.platform_revenue (rls_enabled)
-- public.platform_settings (rls_enabled)
-- public.port_aliases (rls_enabled)
-- public.port_info_chunks (rls_enabled)
-- public.ports (rls_enabled)
-- public.pre_cruise_email_content (rls_enabled)
-- public.price_watches (rls_enabled)
-- public.quote_options (rls_enabled)
-- public.quotes (rls_enabled)
-- public.rag_cost_reconcile_ledger (rls_enabled)
-- public.rag_global_promotions (rls_enabled)
-- public.rag_submissions (rls_enabled)
-- public.request_idempotency (rls_enabled)
-- public.security_incidents (rls_enabled)
-- public.staging_cron_skips (rls_enabled)
-- public.stripe_webhook_events (rls_enabled)
-- public.sub_host_subcontractors (rls_enabled)
-- public.subcontractors (rls_enabled)
-- public.supervisor_review_queue (rls_enabled)
-- public.task_reminders (rls_enabled)
-- public.task_sequence_runs (rls_enabled)
-- public.task_sequence_steps (rls_enabled)
-- public.task_sequences (rls_enabled)
-- public.tasks (rls_enabled)
-- public.tenant_attribution_categories (rls_enabled)
-- public.tenant_branding (rls_enabled)
-- public.tenant_host_configs (rls_enabled)
-- public.tenant_host_fee_overrides (rls_enabled)
-- public.tenant_inactivity_nudges (rls_enabled)
-- public.tenant_override_requests (rls_enabled)
-- public.tenant_persona_overrides (rls_enabled)
-- public.tenant_rag_cap_events (rls_enabled)
-- public.tenant_rag_quotas (rls_enabled)
-- public.tenant_settings (rls_enabled)
-- public.tenant_usage_metrics (rls_enabled)
-- public.tenant_usage_overrides (rls_enabled)
-- public.tenants (rls_enabled)
-- public.tier_definitions (rls_enabled)
-- public.trip_itineraries (rls_enabled)
-- public.trip_resources (rls_enabled)
-- public.usage_limit_events (rls_enabled)
-- public.user_consent_pending (rls_enabled)
-- public.user_data_export_requests (rls_enabled)
-- public.users (rls_enabled)
-- public.voice_profiles (rls_enabled)
-- public.voice_samples (rls_enabled)
-- public.weather_forecast_cache (rls_enabled)
-- public.weather_usage_metrics (rls_enabled)
--
-- Tables with RLS disabled:
-- public.apify_spend_ledger (rls_disabled)
-- public.cruisemapper_url_inventory (rls_disabled)
-- public.destination_images (rls_disabled)
-- public.destination_images_cache (rls_disabled)
-- public.pricing_cache (rls_disabled)
-- public.reconciliation_review_queue (rls_disabled)
-- public.schema_migrations (rls_disabled)

-- Policies:
-- TABLE: public.abuse_recompute_drift_log
CREATE POLICY "ardl_delete_service" ON public.abuse_recompute_drift_log
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "ardl_insert_service" ON public.abuse_recompute_drift_log
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "ardl_select_service" ON public.abuse_recompute_drift_log
  FOR SELECT TO PUBLIC
  USING (false);
CREATE POLICY "ardl_update_service" ON public.abuse_recompute_drift_log
  FOR UPDATE TO PUBLIC
  USING (false);

-- TABLE: public.abuse_signals
CREATE POLICY "abuse_signals_delete_service" ON public.abuse_signals
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "abuse_signals_insert_service" ON public.abuse_signals
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "abuse_signals_select_service" ON public.abuse_signals
  FOR SELECT TO PUBLIC
  USING (false);
CREATE POLICY "abuse_signals_update_service" ON public.abuse_signals
  FOR UPDATE TO PUBLIC
  USING (false);

-- TABLE: public.ai_batch_jobs
CREATE POLICY "ai_batch_jobs_service_role_all" ON public.ai_batch_jobs
  FOR ALL TO PUBLIC
  USING (auth.role() = 'service_role'::text)
  WITH CHECK (auth.role() = 'service_role'::text);

-- TABLE: public.ai_batch_requests
CREATE POLICY "ai_batch_requests_service_role_all" ON public.ai_batch_requests
  FOR ALL TO PUBLIC
  USING (auth.role() = 'service_role'::text)
  WITH CHECK (auth.role() = 'service_role'::text);

-- TABLE: public.ai_call_log
CREATE POLICY "ai_call_log_delete_service" ON public.ai_call_log
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "ai_call_log_insert_service" ON public.ai_call_log
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "ai_call_log_select_service" ON public.ai_call_log
  FOR SELECT TO PUBLIC
  USING (false);
CREATE POLICY "ai_call_log_update_service" ON public.ai_call_log
  FOR UPDATE TO PUBLIC
  USING (false);

-- TABLE: public.ai_kill_switch_state
CREATE POLICY "ai_kill_switch_state_select_policy" ON public.ai_kill_switch_state
  FOR SELECT TO PUBLIC
  USING (auth.uid() IS NOT NULL);

-- TABLE: public.ai_tool_calls
CREATE POLICY "ai_tool_calls_no_user_delete" ON public.ai_tool_calls
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "ai_tool_calls_no_user_insert" ON public.ai_tool_calls
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "ai_tool_calls_no_user_update" ON public.ai_tool_calls
  FOR UPDATE TO PUBLIC
  USING (false);
CREATE POLICY "ai_tool_calls_select_policy" ON public.ai_tool_calls
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));

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

-- TABLE: public.attribution_touches
CREATE POLICY "attribution_touches_delete" ON public.attribution_touches
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "attribution_touches_insert" ON public.attribution_touches
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "attribution_touches_select" ON public.attribution_touches
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "attribution_touches_update" ON public.attribution_touches
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

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

-- TABLE: public.booking_line_items
CREATE POLICY "bli_delete" ON public.booking_line_items
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "bli_insert" ON public.booking_line_items
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "bli_select" ON public.booking_line_items
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "bli_update" ON public.booking_line_items
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

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

-- TABLE: public.bug_submissions
CREATE POLICY "bug_submissions_customer_self" ON public.bug_submissions
  FOR SELECT TO PUBLIC
  USING ((submitter_user_id IN ( SELECT users.id
   FROM users
  WHERE users.auth_user_id = auth.uid())));
CREATE POLICY "bug_submissions_tenant_delete" ON public.bug_submissions
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "bug_submissions_tenant_insert" ON public.bug_submissions
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id));
CREATE POLICY "bug_submissions_tenant_select" ON public.bug_submissions
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "bug_submissions_tenant_update" ON public.bug_submissions
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id));

-- TABLE: public.campaigns
CREATE POLICY "campaigns_delete" ON public.campaigns
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "campaigns_insert" ON public.campaigns
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "campaigns_select" ON public.campaigns
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "campaigns_update" ON public.campaigns
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
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

-- TABLE: public.contact_imports
CREATE POLICY "contact_imports_delete" ON public.contact_imports
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "contact_imports_insert" ON public.contact_imports
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "contact_imports_select" ON public.contact_imports
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "contact_imports_update" ON public.contact_imports
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
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
  USING (auth_user_can_access_conversation(id, tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "conversations_insert_policy" ON public.conversations
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id) AND user_id = (( SELECT u.id
   FROM users u
  WHERE u.auth_user_id = auth.uid() AND u.tenant_id = conversations.tenant_id AND u.status = 'active'::text)));
CREATE POLICY "conversations_select_policy" ON public.conversations
  FOR SELECT TO PUBLIC
  USING (auth_user_can_access_conversation(id, tenant_id));
CREATE POLICY "conversations_update_policy" ON public.conversations
  FOR UPDATE TO PUBLIC
  USING (auth_user_can_access_conversation(id, tenant_id))
  WITH CHECK (auth_user_can_access_conversation(id, tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.cruise_line_aliases
CREATE POLICY "cruise_line_aliases_read" ON public.cruise_line_aliases
  FOR SELECT TO PUBLIC
  USING (auth.uid() IS NOT NULL);

-- TABLE: public.cruise_lines
CREATE POLICY "cruise_lines_read" ON public.cruise_lines
  FOR SELECT TO PUBLIC
  USING (auth.uid() IS NOT NULL);

-- TABLE: public.cruise_ship_aliases
CREATE POLICY "cruise_ship_aliases_read" ON public.cruise_ship_aliases
  FOR SELECT TO PUBLIC
  USING (auth.uid() IS NOT NULL);

-- TABLE: public.cruise_ships
CREATE POLICY "cruise_ships_read" ON public.cruise_ships
  FOR SELECT TO PUBLIC
  USING (auth.uid() IS NOT NULL);

-- TABLE: public.customer_bug_submission_counters
CREATE POLICY "customer_bug_submission_counters_tenant_delete" ON public.customer_bug_submission_counters
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "customer_bug_submission_counters_tenant_insert" ON public.customer_bug_submission_counters
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id));
CREATE POLICY "customer_bug_submission_counters_tenant_select" ON public.customer_bug_submission_counters
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "customer_bug_submission_counters_tenant_update" ON public.customer_bug_submission_counters
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id));

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

-- TABLE: public.feature_requests
CREATE POLICY "feature_requests_customer_self" ON public.feature_requests
  FOR SELECT TO PUBLIC
  USING ((submitter_user_id IN ( SELECT users.id
   FROM users
  WHERE users.auth_user_id = auth.uid())));
CREATE POLICY "feature_requests_tenant_delete" ON public.feature_requests
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "feature_requests_tenant_insert" ON public.feature_requests
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id));
CREATE POLICY "feature_requests_tenant_select" ON public.feature_requests
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "feature_requests_tenant_update" ON public.feature_requests
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id));

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

-- TABLE: public.general_pricing_ranges
CREATE POLICY "general_pricing_ranges_delete" ON public.general_pricing_ranges
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "general_pricing_ranges_insert" ON public.general_pricing_ranges
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "general_pricing_ranges_select" ON public.general_pricing_ranges
  FOR SELECT TO PUBLIC
  USING (auth.uid() IS NOT NULL);
CREATE POLICY "general_pricing_ranges_update" ON public.general_pricing_ranges
  FOR UPDATE TO PUBLIC
  USING (false);

-- TABLE: public.gmail_inbound_messages
CREATE POLICY "gmail_inbound_select" ON public.gmail_inbound_messages
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.gmail_oauth_tokens
CREATE POLICY "gmail_oauth_tokens_select" ON public.gmail_oauth_tokens
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.group_invite_pending_approval
CREATE POLICY "gipa_delete_service" ON public.group_invite_pending_approval
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "gipa_insert_service" ON public.group_invite_pending_approval
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "gipa_select_service" ON public.group_invite_pending_approval
  FOR SELECT TO PUBLIC
  USING (false);
CREATE POLICY "gipa_update_service" ON public.group_invite_pending_approval
  FOR UPDATE TO PUBLIC
  USING (false);

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

-- TABLE: public.help_doc_versions
CREATE POLICY "help_doc_versions_delete" ON public.help_doc_versions
  FOR DELETE TO PUBLIC
  USING (tenant_id IS NULL OR auth_user_in_tenant(tenant_id));
CREATE POLICY "help_doc_versions_insert" ON public.help_doc_versions
  FOR INSERT TO PUBLIC
  WITH CHECK (tenant_id IS NULL OR auth_user_in_tenant(tenant_id));
CREATE POLICY "help_doc_versions_select" ON public.help_doc_versions
  FOR SELECT TO PUBLIC
  USING (tenant_id IS NULL OR auth_user_in_tenant(tenant_id));
CREATE POLICY "help_doc_versions_update" ON public.help_doc_versions
  FOR UPDATE TO PUBLIC
  USING (tenant_id IS NULL OR auth_user_in_tenant(tenant_id))
  WITH CHECK (tenant_id IS NULL OR auth_user_in_tenant(tenant_id));

-- TABLE: public.help_sessions
CREATE POLICY "help_sessions_tenant_delete" ON public.help_sessions
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "help_sessions_tenant_insert" ON public.help_sessions
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id));
CREATE POLICY "help_sessions_tenant_select" ON public.help_sessions
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "help_sessions_tenant_update" ON public.help_sessions
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id));

-- TABLE: public.host_adapters
CREATE POLICY "host_adapters_select_policy" ON public.host_adapters
  FOR SELECT TO PUBLIC
  USING (auth.role() = 'authenticated'::text OR auth.role() = 'service_role'::text);

-- TABLE: public.host_booking_fee_configs
CREATE POLICY "host_booking_fee_configs_select_policy" ON public.host_booking_fee_configs
  FOR SELECT TO PUBLIC
  USING (auth.role() = 'authenticated'::text OR auth.role() = 'service_role'::text);

-- TABLE: public.import_queue
CREATE POLICY "import_queue_delete" ON public.import_queue
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "import_queue_insert" ON public.import_queue
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "import_queue_select" ON public.import_queue
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "import_queue_update" ON public.import_queue
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

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
  USING (auth_user_can_access_conversation(conversation_id, tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "messages_insert_policy" ON public.messages
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_can_access_conversation(conversation_id, tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "messages_select_policy" ON public.messages
  FOR SELECT TO PUBLIC
  USING (auth_user_can_access_conversation(conversation_id, tenant_id));
CREATE POLICY "messages_update_policy" ON public.messages
  FOR UPDATE TO PUBLIC
  USING (auth_user_can_access_conversation(conversation_id, tenant_id))
  WITH CHECK (auth_user_can_access_conversation(conversation_id, tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.news_articles
CREATE POLICY "no_access" ON public.news_articles
  FOR ALL TO PUBLIC
  USING (false)
  WITH CHECK (false);

-- TABLE: public.news_feeds
CREATE POLICY "no_access" ON public.news_feeds
  FOR ALL TO PUBLIC
  USING (false)
  WITH CHECK (false);

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

-- TABLE: public.persona_safety_config
CREATE POLICY "persona_safety_config_delete_deny" ON public.persona_safety_config
  FOR DELETE TO authenticated
  USING (false);
CREATE POLICY "persona_safety_config_insert_deny" ON public.persona_safety_config
  FOR INSERT TO authenticated
  WITH CHECK (false);
CREATE POLICY "persona_safety_config_select_policy" ON public.persona_safety_config
  FOR SELECT TO PUBLIC
  USING (auth.uid() IS NOT NULL);
CREATE POLICY "persona_safety_config_update_deny" ON public.persona_safety_config
  FOR UPDATE TO authenticated
  USING (false)
  WITH CHECK (false);

-- TABLE: public.personas
CREATE POLICY "personas_delete_deny" ON public.personas
  FOR DELETE TO authenticated
  USING (false);
CREATE POLICY "personas_insert_deny" ON public.personas
  FOR INSERT TO authenticated
  WITH CHECK (false);
CREATE POLICY "personas_select_policy" ON public.personas
  FOR SELECT TO PUBLIC
  USING (auth.uid() IS NOT NULL);
CREATE POLICY "personas_update_deny" ON public.personas
  FOR UPDATE TO authenticated
  USING (false)
  WITH CHECK (false);

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

-- TABLE: public.platform_admins
CREATE POLICY "platform_admins_delete_deny" ON public.platform_admins
  FOR DELETE TO authenticated
  USING (false);
CREATE POLICY "platform_admins_insert_deny" ON public.platform_admins
  FOR INSERT TO authenticated
  WITH CHECK (false);
CREATE POLICY "platform_admins_select_deny" ON public.platform_admins
  FOR SELECT TO authenticated
  USING (false);
CREATE POLICY "platform_admins_update_deny" ON public.platform_admins
  FOR UPDATE TO authenticated
  USING (false)
  WITH CHECK (false);

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

-- TABLE: public.port_aliases
CREATE POLICY "port_aliases_read" ON public.port_aliases
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

-- TABLE: public.ports
CREATE POLICY "ports_read" ON public.ports
  FOR SELECT TO PUBLIC
  USING (auth.uid() IS NOT NULL);

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

-- TABLE: public.price_watches
CREATE POLICY "price_watches_tenant_delete" ON public.price_watches
  FOR DELETE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "price_watches_tenant_insert" ON public.price_watches
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id));
CREATE POLICY "price_watches_tenant_select" ON public.price_watches
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "price_watches_tenant_update" ON public.price_watches
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id));

-- TABLE: public.quote_options
CREATE POLICY "quote_options_delete" ON public.quote_options
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "quote_options_insert" ON public.quote_options
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "quote_options_select" ON public.quote_options
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "quote_options_update" ON public.quote_options
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

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

-- TABLE: public.rag_cost_reconcile_ledger
CREATE POLICY "rag_cost_reconcile_ledger_no_user_delete" ON public.rag_cost_reconcile_ledger
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "rag_cost_reconcile_ledger_no_user_insert" ON public.rag_cost_reconcile_ledger
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "rag_cost_reconcile_ledger_no_user_select" ON public.rag_cost_reconcile_ledger
  FOR SELECT TO PUBLIC
  USING (false);
CREATE POLICY "rag_cost_reconcile_ledger_no_user_update" ON public.rag_cost_reconcile_ledger
  FOR UPDATE TO PUBLIC
  USING (false);

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

-- TABLE: public.request_idempotency
CREATE POLICY "request_idempotency_no_user_delete" ON public.request_idempotency
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "request_idempotency_no_user_insert" ON public.request_idempotency
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "request_idempotency_no_user_select" ON public.request_idempotency
  FOR SELECT TO PUBLIC
  USING (false);
CREATE POLICY "request_idempotency_no_user_update" ON public.request_idempotency
  FOR UPDATE TO PUBLIC
  USING (false);

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

-- TABLE: public.task_reminders
CREATE POLICY "task_reminders_delete" ON public.task_reminders
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "task_reminders_insert" ON public.task_reminders
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "task_reminders_select" ON public.task_reminders
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "task_reminders_update" ON public.task_reminders
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.task_sequence_runs
CREATE POLICY "task_sequence_runs_delete" ON public.task_sequence_runs
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "task_sequence_runs_insert" ON public.task_sequence_runs
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "task_sequence_runs_select" ON public.task_sequence_runs
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "task_sequence_runs_update" ON public.task_sequence_runs
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.task_sequence_steps
CREATE POLICY "task_sequence_steps_delete" ON public.task_sequence_steps
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "task_sequence_steps_insert" ON public.task_sequence_steps
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "task_sequence_steps_select" ON public.task_sequence_steps
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "task_sequence_steps_update" ON public.task_sequence_steps
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.task_sequences
CREATE POLICY "task_sequences_delete" ON public.task_sequences
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "task_sequences_insert" ON public.task_sequences
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "task_sequences_select" ON public.task_sequences
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "task_sequences_update" ON public.task_sequences
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.tasks
CREATE POLICY "tasks_delete" ON public.tasks
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "tasks_insert" ON public.tasks
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "tasks_select" ON public.tasks
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "tasks_update" ON public.tasks
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.tenant_attribution_categories
CREATE POLICY "tenant_attr_categories_delete" ON public.tenant_attribution_categories
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "tenant_attr_categories_insert" ON public.tenant_attribution_categories
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "tenant_attr_categories_select" ON public.tenant_attribution_categories
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "tenant_attr_categories_update" ON public.tenant_attribution_categories
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
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

-- TABLE: public.tenant_override_requests
CREATE POLICY "tor_delete_service" ON public.tenant_override_requests
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "tor_insert_in_tenant" ON public.tenant_override_requests
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "tor_select_in_tenant" ON public.tenant_override_requests
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "tor_update_service" ON public.tenant_override_requests
  FOR UPDATE TO PUBLIC
  USING (false);

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

-- TABLE: public.tenant_rag_cap_events
CREATE POLICY "trce_delete_service" ON public.tenant_rag_cap_events
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "trce_insert_service" ON public.tenant_rag_cap_events
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "trce_select_service" ON public.tenant_rag_cap_events
  FOR SELECT TO PUBLIC
  USING (false);
CREATE POLICY "trce_update_service" ON public.tenant_rag_cap_events
  FOR UPDATE TO PUBLIC
  USING (false);

-- TABLE: public.tenant_rag_quotas
CREATE POLICY "trq_delete_service" ON public.tenant_rag_quotas
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "trq_insert_service" ON public.tenant_rag_quotas
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "trq_select_in_tenant" ON public.tenant_rag_quotas
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "trq_update_service" ON public.tenant_rag_quotas
  FOR UPDATE TO PUBLIC
  USING (false);

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

-- TABLE: public.tenant_usage_metrics
CREATE POLICY "tum_delete_service" ON public.tenant_usage_metrics
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "tum_insert_service" ON public.tenant_usage_metrics
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "tum_select_in_tenant" ON public.tenant_usage_metrics
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "tum_update_service" ON public.tenant_usage_metrics
  FOR UPDATE TO PUBLIC
  USING (false);

-- TABLE: public.tenant_usage_overrides
CREATE POLICY "tuo_delete_service" ON public.tenant_usage_overrides
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "tuo_insert_service" ON public.tenant_usage_overrides
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "tuo_select_service" ON public.tenant_usage_overrides
  FOR SELECT TO PUBLIC
  USING (false);
CREATE POLICY "tuo_update_service" ON public.tenant_usage_overrides
  FOR UPDATE TO PUBLIC
  USING (false);

-- TABLE: public.tenants
CREATE POLICY "tenants_select_policy" ON public.tenants
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(id));
CREATE POLICY "tenants_update_policy" ON public.tenants
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(id))
  WITH CHECK (auth_user_in_tenant(id) AND tenant_is_active(id));

-- TABLE: public.trip_itineraries
CREATE POLICY "trip_itineraries_delete" ON public.trip_itineraries
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "trip_itineraries_insert" ON public.trip_itineraries
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "trip_itineraries_select" ON public.trip_itineraries
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "trip_itineraries_update" ON public.trip_itineraries
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.trip_resources
CREATE POLICY "trip_resources_delete" ON public.trip_resources
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "trip_resources_insert" ON public.trip_resources
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "trip_resources_select" ON public.trip_resources
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "trip_resources_update" ON public.trip_resources
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.usage_limit_events
CREATE POLICY "ule_delete_service" ON public.usage_limit_events
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "ule_insert_service" ON public.usage_limit_events
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "ule_select_service" ON public.usage_limit_events
  FOR SELECT TO PUBLIC
  USING (false);
CREATE POLICY "ule_update_service" ON public.usage_limit_events
  FOR UPDATE TO PUBLIC
  USING (false);

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

-- TABLE: public.voice_profiles
CREATE POLICY "voice_profiles_delete_policy" ON public.voice_profiles
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "voice_profiles_insert_policy" ON public.voice_profiles
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "voice_profiles_select_policy" ON public.voice_profiles
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "voice_profiles_update_policy" ON public.voice_profiles
  FOR UPDATE TO PUBLIC
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));

-- TABLE: public.voice_samples
CREATE POLICY "voice_samples_delete_policy" ON public.voice_samples
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "voice_samples_insert_policy" ON public.voice_samples
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY "voice_samples_select_policy" ON public.voice_samples
  FOR SELECT TO PUBLIC
  USING (auth_user_in_tenant(tenant_id));
CREATE POLICY "voice_samples_update_policy" ON public.voice_samples
  FOR UPDATE TO PUBLIC
  USING (false)
  WITH CHECK (false);

-- TABLE: public.weather_forecast_cache
CREATE POLICY "weather_forecast_cache_no_user_delete" ON public.weather_forecast_cache
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "weather_forecast_cache_no_user_insert" ON public.weather_forecast_cache
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "weather_forecast_cache_no_user_select" ON public.weather_forecast_cache
  FOR SELECT TO PUBLIC
  USING (false);
CREATE POLICY "weather_forecast_cache_no_user_update" ON public.weather_forecast_cache
  FOR UPDATE TO PUBLIC
  USING (false);

-- TABLE: public.weather_usage_metrics
CREATE POLICY "weather_usage_metrics_no_user_delete" ON public.weather_usage_metrics
  FOR DELETE TO PUBLIC
  USING (false);
CREATE POLICY "weather_usage_metrics_no_user_insert" ON public.weather_usage_metrics
  FOR INSERT TO PUBLIC
  WITH CHECK (false);
CREATE POLICY "weather_usage_metrics_no_user_select" ON public.weather_usage_metrics
  FOR SELECT TO PUBLIC
  USING (false);
CREATE POLICY "weather_usage_metrics_no_user_update" ON public.weather_usage_metrics
  FOR UPDATE TO PUBLIC
  USING (false);

