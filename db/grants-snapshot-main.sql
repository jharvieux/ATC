-- AUTO-GENERATED GRANTS SNAPSHOT - DO NOT EDIT MANUALLY
-- Target: main
-- Regenerate with: npx tsx scripts/grants-snapshot.ts --target=main > db/grants-snapshot-main.sql
-- Generated against schema: public
-- Captures DML grants (SELECT, INSERT, UPDATE, DELETE) for roles anon, authenticated, service_role.

-- TABLE: public.abuse_recompute_drift_log
GRANT DELETE, INSERT, SELECT, UPDATE ON public.abuse_recompute_drift_log TO service_role;

-- TABLE: public.abuse_signals
GRANT DELETE, INSERT, SELECT, UPDATE ON public.abuse_signals TO service_role;

-- TABLE: public.ai_batch_jobs
GRANT DELETE, INSERT, SELECT, UPDATE ON public.ai_batch_jobs TO service_role;

-- TABLE: public.ai_batch_requests
GRANT DELETE, INSERT, SELECT, UPDATE ON public.ai_batch_requests TO service_role;

-- TABLE: public.ai_call_log
GRANT DELETE, INSERT, SELECT, UPDATE ON public.ai_call_log TO service_role;

-- TABLE: public.ai_kill_switch_state
GRANT SELECT ON public.ai_kill_switch_state TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.ai_kill_switch_state TO service_role;

-- TABLE: public.ai_tool_calls
GRANT INSERT, SELECT ON public.ai_tool_calls TO service_role;

-- TABLE: public.anonymous_chat_counters
GRANT DELETE, INSERT, SELECT, UPDATE ON public.anonymous_chat_counters TO service_role;

-- TABLE: public.anonymous_sessions
GRANT DELETE, INSERT, SELECT, UPDATE ON public.anonymous_sessions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.anonymous_sessions TO service_role;

-- TABLE: public.apify_spend_ledger
GRANT INSERT, SELECT ON public.apify_spend_ledger TO service_role;

-- TABLE: public.attribution_touches
GRANT DELETE, INSERT, SELECT, UPDATE ON public.attribution_touches TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.attribution_touches TO service_role;

-- TABLE: public.audit_log
GRANT SELECT ON public.audit_log TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.audit_log TO service_role;

-- TABLE: public.auth_attempts
GRANT DELETE, INSERT, SELECT, UPDATE ON public.auth_attempts TO service_role;

-- TABLE: public.booking_line_items
GRANT DELETE, INSERT, SELECT, UPDATE ON public.booking_line_items TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.booking_line_items TO service_role;

-- TABLE: public.booking_options
GRANT DELETE, INSERT, SELECT, UPDATE ON public.booking_options TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.booking_options TO service_role;

-- TABLE: public.booking_passengers
GRANT DELETE, INSERT, SELECT, UPDATE ON public.booking_passengers TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.booking_passengers TO service_role;

-- TABLE: public.bookings
GRANT DELETE, INSERT, SELECT, UPDATE ON public.bookings TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.bookings TO service_role;

-- TABLE: public.bug_submissions
GRANT INSERT, SELECT, UPDATE ON public.bug_submissions TO service_role;

-- TABLE: public.campaigns
GRANT DELETE, INSERT, SELECT, UPDATE ON public.campaigns TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.campaigns TO service_role;

-- TABLE: public.ccpa_deletion_executions
GRANT SELECT ON public.ccpa_deletion_executions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.ccpa_deletion_executions TO service_role;

-- TABLE: public.commissions
GRANT DELETE, INSERT, SELECT, UPDATE ON public.commissions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.commissions TO service_role;

-- TABLE: public.complaints
GRANT INSERT, SELECT ON public.complaints TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.complaints TO service_role;

-- TABLE: public.contact_imports
GRANT DELETE, INSERT, SELECT, UPDATE ON public.contact_imports TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.contact_imports TO service_role;

-- TABLE: public.contact_relationships
GRANT DELETE, INSERT, SELECT, UPDATE ON public.contact_relationships TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.contact_relationships TO service_role;

-- TABLE: public.contacts
GRANT DELETE, INSERT, SELECT, UPDATE ON public.contacts TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.contacts TO service_role;

-- TABLE: public.conversations
GRANT DELETE, INSERT, SELECT, UPDATE ON public.conversations TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.conversations TO service_role;

-- TABLE: public.cruisemapper_url_inventory
GRANT INSERT, SELECT, UPDATE ON public.cruisemapper_url_inventory TO service_role;

-- TABLE: public.customer_bug_submission_counters
GRANT INSERT, SELECT, UPDATE ON public.customer_bug_submission_counters TO service_role;

-- TABLE: public.customer_chat_counters
GRANT SELECT ON public.customer_chat_counters TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.customer_chat_counters TO service_role;

-- TABLE: public.customer_chat_tenant_overrides
GRANT SELECT ON public.customer_chat_tenant_overrides TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.customer_chat_tenant_overrides TO service_role;

-- TABLE: public.customer_memories
GRANT DELETE, INSERT, SELECT, UPDATE ON public.customer_memories TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.customer_memories TO service_role;

-- TABLE: public.destination_images
GRANT SELECT ON public.destination_images TO service_role;

-- TABLE: public.destination_images_cache
GRANT INSERT, SELECT, UPDATE ON public.destination_images_cache TO service_role;

-- TABLE: public.email_log
GRANT SELECT ON public.email_log TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.email_log TO service_role;

-- TABLE: public.email_suppressions
GRANT SELECT ON public.email_suppressions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.email_suppressions TO service_role;

-- TABLE: public.escalation_topics
GRANT DELETE, INSERT, SELECT, UPDATE ON public.escalation_topics TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.escalation_topics TO service_role;

-- TABLE: public.feature_requests
GRANT INSERT, SELECT, UPDATE ON public.feature_requests TO service_role;

-- TABLE: public.forensics_log
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forensics_log TO service_role;

-- TABLE: public.forum_messages
GRANT INSERT, SELECT, UPDATE ON public.forum_messages TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_messages TO service_role;

-- TABLE: public.forum_reactions
GRANT DELETE, INSERT, SELECT ON public.forum_reactions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_reactions TO service_role;

-- TABLE: public.forum_strikes
GRANT INSERT, SELECT ON public.forum_strikes TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_strikes TO service_role;

-- TABLE: public.forum_threads
GRANT INSERT, SELECT, UPDATE ON public.forum_threads TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_threads TO service_role;

-- TABLE: public.forum_user_state
GRANT INSERT, SELECT, UPDATE ON public.forum_user_state TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_user_state TO service_role;

-- TABLE: public.forums
GRANT INSERT, SELECT, UPDATE ON public.forums TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forums TO service_role;

-- TABLE: public.general_pricing_ranges
GRANT SELECT ON public.general_pricing_ranges TO authenticated;
GRANT INSERT, SELECT, UPDATE ON public.general_pricing_ranges TO service_role;

-- TABLE: public.gmail_inbound_messages
GRANT SELECT ON public.gmail_inbound_messages TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.gmail_inbound_messages TO service_role;

-- TABLE: public.gmail_oauth_tokens
GRANT SELECT ON public.gmail_oauth_tokens TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.gmail_oauth_tokens TO service_role;

-- TABLE: public.group_invite_pending_approval
GRANT DELETE, INSERT, SELECT, UPDATE ON public.group_invite_pending_approval TO service_role;

-- TABLE: public.groups
GRANT INSERT, SELECT, UPDATE ON public.groups TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.groups TO service_role;

-- TABLE: public.help_doc_versions
GRANT DELETE, INSERT, SELECT, UPDATE ON public.help_doc_versions TO service_role;

-- TABLE: public.help_sessions
GRANT INSERT, SELECT, UPDATE ON public.help_sessions TO service_role;

-- TABLE: public.host_adapters
GRANT SELECT ON public.host_adapters TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.host_adapters TO service_role;

-- TABLE: public.host_booking_fee_configs
GRANT SELECT ON public.host_booking_fee_configs TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.host_booking_fee_configs TO service_role;

-- TABLE: public.import_queue
GRANT DELETE, INSERT, SELECT, UPDATE ON public.import_queue TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.import_queue TO service_role;

-- TABLE: public.invitations
GRANT INSERT, SELECT, UPDATE ON public.invitations TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.invitations TO service_role;

-- TABLE: public.legal_consents
GRANT SELECT ON public.legal_consents TO authenticated;
GRANT INSERT, SELECT ON public.legal_consents TO service_role;

-- TABLE: public.legal_documents
GRANT SELECT ON public.legal_documents TO authenticated;
GRANT INSERT, SELECT, UPDATE ON public.legal_documents TO service_role;

-- TABLE: public.messages
GRANT DELETE, INSERT, SELECT, UPDATE ON public.messages TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.messages TO service_role;

-- TABLE: public.news_articles
GRANT DELETE, INSERT, SELECT, UPDATE ON public.news_articles TO service_role;

-- TABLE: public.news_feeds
GRANT DELETE, INSERT, SELECT, UPDATE ON public.news_feeds TO service_role;

-- TABLE: public.notifications
GRANT SELECT, UPDATE ON public.notifications TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.notifications TO service_role;

-- TABLE: public.payout_balances
GRANT DELETE, INSERT, SELECT, UPDATE ON public.payout_balances TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.payout_balances TO service_role;

-- TABLE: public.payout_records
GRANT DELETE, INSERT, SELECT, UPDATE ON public.payout_records TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.payout_records TO service_role;

-- TABLE: public.pending_rag_sync
GRANT DELETE, INSERT, SELECT, UPDATE ON public.pending_rag_sync TO service_role;

-- TABLE: public.persona_addendums
GRANT DELETE, INSERT, SELECT, UPDATE ON public.persona_addendums TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.persona_addendums TO service_role;

-- TABLE: public.persona_safety_config
GRANT SELECT ON public.persona_safety_config TO authenticated;
GRANT SELECT, UPDATE ON public.persona_safety_config TO service_role;

-- TABLE: public.personas
GRANT SELECT ON public.personas TO authenticated;
GRANT SELECT, UPDATE ON public.personas TO service_role;

-- TABLE: public.pipeline_stages
GRANT DELETE, INSERT, SELECT, UPDATE ON public.pipeline_stages TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.pipeline_stages TO service_role;

-- TABLE: public.platform_admins
GRANT SELECT ON public.platform_admins TO service_role;

-- TABLE: public.platform_revenue
GRANT DELETE, INSERT, SELECT, UPDATE ON public.platform_revenue TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.platform_revenue TO service_role;

-- TABLE: public.platform_settings
GRANT SELECT ON public.platform_settings TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.platform_settings TO service_role;

-- TABLE: public.port_info_chunks
GRANT SELECT ON public.port_info_chunks TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.port_info_chunks TO service_role;

-- TABLE: public.pre_cruise_email_content
GRANT SELECT ON public.pre_cruise_email_content TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.pre_cruise_email_content TO service_role;

-- TABLE: public.price_watches
GRANT INSERT, SELECT, UPDATE ON public.price_watches TO service_role;

-- TABLE: public.pricing_cache
GRANT INSERT, SELECT, UPDATE ON public.pricing_cache TO service_role;

-- TABLE: public.quote_options
GRANT DELETE, INSERT, SELECT, UPDATE ON public.quote_options TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.quote_options TO service_role;

-- TABLE: public.quotes
GRANT DELETE, INSERT, SELECT, UPDATE ON public.quotes TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.quotes TO service_role;

-- TABLE: public.rag_cost_reconcile_ledger
GRANT DELETE, INSERT, SELECT, UPDATE ON public.rag_cost_reconcile_ledger TO service_role;

-- TABLE: public.rag_global_promotions
GRANT SELECT ON public.rag_global_promotions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.rag_global_promotions TO service_role;

-- TABLE: public.rag_submissions
GRANT INSERT, SELECT, UPDATE ON public.rag_submissions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.rag_submissions TO service_role;

-- TABLE: public.reconciliation_review_queue
GRANT DELETE, INSERT, SELECT, UPDATE ON public.reconciliation_review_queue TO service_role;

-- TABLE: public.request_idempotency
GRANT DELETE, INSERT, SELECT, UPDATE ON public.request_idempotency TO service_role;

-- TABLE: public.schema_migrations
-- (no DML grants to anon/authenticated/service_role)

-- TABLE: public.security_incidents
GRANT DELETE, INSERT, SELECT, UPDATE ON public.security_incidents TO service_role;

-- TABLE: public.staging_cron_skips
GRANT DELETE, INSERT, SELECT, UPDATE ON public.staging_cron_skips TO service_role;

-- TABLE: public.stripe_webhook_events
GRANT DELETE, INSERT, SELECT, UPDATE ON public.stripe_webhook_events TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.stripe_webhook_events TO service_role;

-- TABLE: public.sub_host_subcontractors
GRANT DELETE, INSERT, SELECT, UPDATE ON public.sub_host_subcontractors TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.sub_host_subcontractors TO service_role;

-- TABLE: public.subcontractors
GRANT DELETE, INSERT, SELECT, UPDATE ON public.subcontractors TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.subcontractors TO service_role;

-- TABLE: public.supervisor_review_queue
GRANT DELETE, INSERT, SELECT, UPDATE ON public.supervisor_review_queue TO service_role;

-- TABLE: public.task_reminders
GRANT DELETE, INSERT, SELECT, UPDATE ON public.task_reminders TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.task_reminders TO service_role;

-- TABLE: public.task_sequence_runs
GRANT DELETE, INSERT, SELECT, UPDATE ON public.task_sequence_runs TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.task_sequence_runs TO service_role;

-- TABLE: public.task_sequence_steps
GRANT DELETE, INSERT, SELECT, UPDATE ON public.task_sequence_steps TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.task_sequence_steps TO service_role;

-- TABLE: public.task_sequences
GRANT DELETE, INSERT, SELECT, UPDATE ON public.task_sequences TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.task_sequences TO service_role;

-- TABLE: public.tasks
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tasks TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tasks TO service_role;

-- TABLE: public.tenant_attribution_categories
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_attribution_categories TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_attribution_categories TO service_role;

-- TABLE: public.tenant_branding
GRANT INSERT, SELECT, UPDATE ON public.tenant_branding TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_branding TO service_role;

-- TABLE: public.tenant_host_configs
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_host_configs TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_host_configs TO service_role;

-- TABLE: public.tenant_host_fee_overrides
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_host_fee_overrides TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_host_fee_overrides TO service_role;

-- TABLE: public.tenant_inactivity_nudges
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_inactivity_nudges TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_inactivity_nudges TO service_role;

-- TABLE: public.tenant_override_requests
GRANT INSERT, SELECT ON public.tenant_override_requests TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_override_requests TO service_role;

-- TABLE: public.tenant_persona_overrides
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_persona_overrides TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_persona_overrides TO service_role;

-- TABLE: public.tenant_rag_cap_events
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_rag_cap_events TO service_role;

-- TABLE: public.tenant_rag_quotas
GRANT SELECT ON public.tenant_rag_quotas TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_rag_quotas TO service_role;

-- TABLE: public.tenant_settings
GRANT INSERT, SELECT, UPDATE ON public.tenant_settings TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_settings TO service_role;

-- TABLE: public.tenant_usage_metrics
GRANT SELECT ON public.tenant_usage_metrics TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_usage_metrics TO service_role;

-- TABLE: public.tenant_usage_overrides
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_usage_overrides TO service_role;

-- TABLE: public.tenants
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenants TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenants TO service_role;

-- TABLE: public.tier_definitions
GRANT SELECT ON public.tier_definitions TO anon;
GRANT SELECT ON public.tier_definitions TO authenticated;
GRANT SELECT ON public.tier_definitions TO service_role;

-- TABLE: public.trip_itineraries
GRANT DELETE, INSERT, SELECT, UPDATE ON public.trip_itineraries TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.trip_itineraries TO service_role;

-- TABLE: public.trip_resources
GRANT DELETE, INSERT, SELECT, UPDATE ON public.trip_resources TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.trip_resources TO service_role;

-- TABLE: public.usage_limit_events
GRANT DELETE, INSERT, SELECT, UPDATE ON public.usage_limit_events TO service_role;

-- TABLE: public.user_consent_pending
GRANT SELECT ON public.user_consent_pending TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.user_consent_pending TO service_role;

-- TABLE: public.user_data_export_requests
GRANT INSERT, SELECT ON public.user_data_export_requests TO authenticated;
GRANT INSERT, SELECT, UPDATE ON public.user_data_export_requests TO service_role;

-- TABLE: public.users
GRANT DELETE, INSERT, SELECT, UPDATE ON public.users TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.users TO service_role;

-- TABLE: public.voice_profiles
GRANT INSERT, SELECT, UPDATE ON public.voice_profiles TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.voice_profiles TO service_role;

-- TABLE: public.voice_samples
GRANT INSERT, SELECT ON public.voice_samples TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.voice_samples TO service_role;

-- TABLE: public.weather_forecast_cache
GRANT DELETE, INSERT, SELECT, UPDATE ON public.weather_forecast_cache TO service_role;

-- TABLE: public.weather_usage_metrics
GRANT DELETE, INSERT, SELECT, UPDATE ON public.weather_usage_metrics TO service_role;

