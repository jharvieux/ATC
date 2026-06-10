-- AUTO-GENERATED GRANTS SNAPSHOT - DO NOT EDIT MANUALLY
-- Target: main
-- Regenerate with: npx tsx scripts/grants-snapshot.ts --target=main > db/grants-snapshot-main.sql
-- Generated against schema: public
-- Captures DML grants (SELECT, INSERT, UPDATE, DELETE) for roles anon, authenticated, service_role.

-- TABLE: public.abuse_recompute_drift_log
GRANT DELETE, INSERT, SELECT, UPDATE ON public.abuse_recompute_drift_log TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.abuse_recompute_drift_log TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.abuse_recompute_drift_log TO service_role;

-- TABLE: public.abuse_signals
GRANT DELETE, INSERT, SELECT, UPDATE ON public.abuse_signals TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.abuse_signals TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.abuse_signals TO service_role;

-- TABLE: public.ai_call_log
GRANT DELETE, INSERT, SELECT, UPDATE ON public.ai_call_log TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.ai_call_log TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.ai_call_log TO service_role;

-- TABLE: public.ai_kill_switch_state
GRANT DELETE, INSERT, SELECT, UPDATE ON public.ai_kill_switch_state TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.ai_kill_switch_state TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.ai_kill_switch_state TO service_role;

-- TABLE: public.anonymous_chat_counters
GRANT DELETE, INSERT, SELECT, UPDATE ON public.anonymous_chat_counters TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.anonymous_chat_counters TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.anonymous_chat_counters TO service_role;

-- TABLE: public.anonymous_sessions
GRANT DELETE, INSERT, SELECT, UPDATE ON public.anonymous_sessions TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.anonymous_sessions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.anonymous_sessions TO service_role;

-- TABLE: public.apify_spend_ledger
GRANT DELETE, INSERT, SELECT, UPDATE ON public.apify_spend_ledger TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.apify_spend_ledger TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.apify_spend_ledger TO service_role;

-- TABLE: public.audit_log
GRANT DELETE, INSERT, SELECT, UPDATE ON public.audit_log TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.audit_log TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.audit_log TO service_role;

-- TABLE: public.auth_attempts
GRANT DELETE, INSERT, SELECT, UPDATE ON public.auth_attempts TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.auth_attempts TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.auth_attempts TO service_role;

-- TABLE: public.booking_options
GRANT DELETE, INSERT, SELECT, UPDATE ON public.booking_options TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.booking_options TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.booking_options TO service_role;

-- TABLE: public.booking_passengers
GRANT DELETE, INSERT, SELECT, UPDATE ON public.booking_passengers TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.booking_passengers TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.booking_passengers TO service_role;

-- TABLE: public.bookings
GRANT DELETE, INSERT, SELECT, UPDATE ON public.bookings TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.bookings TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.bookings TO service_role;

-- TABLE: public.bug_submissions
GRANT DELETE, INSERT, SELECT, UPDATE ON public.bug_submissions TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.bug_submissions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.bug_submissions TO service_role;

-- TABLE: public.ccpa_deletion_executions
GRANT DELETE, INSERT, SELECT, UPDATE ON public.ccpa_deletion_executions TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.ccpa_deletion_executions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.ccpa_deletion_executions TO service_role;

-- TABLE: public.commissions
GRANT DELETE, INSERT, SELECT, UPDATE ON public.commissions TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.commissions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.commissions TO service_role;

-- TABLE: public.complaints
GRANT DELETE, INSERT, SELECT, UPDATE ON public.complaints TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.complaints TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.complaints TO service_role;

-- TABLE: public.contact_relationships
GRANT DELETE, INSERT, SELECT, UPDATE ON public.contact_relationships TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.contact_relationships TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.contact_relationships TO service_role;

-- TABLE: public.contacts
GRANT DELETE, INSERT, SELECT, UPDATE ON public.contacts TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.contacts TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.contacts TO service_role;

-- TABLE: public.conversations
GRANT DELETE, INSERT, SELECT, UPDATE ON public.conversations TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.conversations TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.conversations TO service_role;

-- TABLE: public.cruisemapper_url_inventory
GRANT DELETE, INSERT, SELECT, UPDATE ON public.cruisemapper_url_inventory TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.cruisemapper_url_inventory TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.cruisemapper_url_inventory TO service_role;

-- TABLE: public.customer_bug_submission_counters
GRANT DELETE, INSERT, SELECT, UPDATE ON public.customer_bug_submission_counters TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.customer_bug_submission_counters TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.customer_bug_submission_counters TO service_role;

-- TABLE: public.customer_chat_counters
GRANT DELETE, INSERT, SELECT, UPDATE ON public.customer_chat_counters TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.customer_chat_counters TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.customer_chat_counters TO service_role;

-- TABLE: public.customer_chat_tenant_overrides
GRANT DELETE, INSERT, SELECT, UPDATE ON public.customer_chat_tenant_overrides TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.customer_chat_tenant_overrides TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.customer_chat_tenant_overrides TO service_role;

-- TABLE: public.customer_memories
GRANT DELETE, INSERT, SELECT, UPDATE ON public.customer_memories TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.customer_memories TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.customer_memories TO service_role;

-- TABLE: public.destination_images
GRANT DELETE, INSERT, SELECT, UPDATE ON public.destination_images TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.destination_images TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.destination_images TO service_role;

-- TABLE: public.destination_images_cache
GRANT DELETE, INSERT, SELECT, UPDATE ON public.destination_images_cache TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.destination_images_cache TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.destination_images_cache TO service_role;

-- TABLE: public.email_log
GRANT DELETE, INSERT, SELECT, UPDATE ON public.email_log TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.email_log TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.email_log TO service_role;

-- TABLE: public.email_suppressions
GRANT DELETE, INSERT, SELECT, UPDATE ON public.email_suppressions TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.email_suppressions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.email_suppressions TO service_role;

-- TABLE: public.escalation_topics
GRANT DELETE, INSERT, SELECT, UPDATE ON public.escalation_topics TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.escalation_topics TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.escalation_topics TO service_role;

-- TABLE: public.feature_requests
GRANT DELETE, INSERT, SELECT, UPDATE ON public.feature_requests TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.feature_requests TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.feature_requests TO service_role;

-- TABLE: public.forensics_log
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forensics_log TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forensics_log TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forensics_log TO service_role;

-- TABLE: public.forum_messages
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_messages TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_messages TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_messages TO service_role;

-- TABLE: public.forum_reactions
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_reactions TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_reactions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_reactions TO service_role;

-- TABLE: public.forum_strikes
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_strikes TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_strikes TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_strikes TO service_role;

-- TABLE: public.forum_threads
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_threads TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_threads TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_threads TO service_role;

-- TABLE: public.forum_user_state
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_user_state TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_user_state TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forum_user_state TO service_role;

-- TABLE: public.forums
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forums TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forums TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.forums TO service_role;

-- TABLE: public.general_pricing_ranges
GRANT DELETE, INSERT, SELECT, UPDATE ON public.general_pricing_ranges TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.general_pricing_ranges TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.general_pricing_ranges TO service_role;

-- TABLE: public.group_invite_pending_approval
GRANT DELETE, INSERT, SELECT, UPDATE ON public.group_invite_pending_approval TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.group_invite_pending_approval TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.group_invite_pending_approval TO service_role;

-- TABLE: public.groups
GRANT DELETE, INSERT, SELECT, UPDATE ON public.groups TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.groups TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.groups TO service_role;

-- TABLE: public.help_doc_versions
GRANT DELETE, INSERT, SELECT, UPDATE ON public.help_doc_versions TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.help_doc_versions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.help_doc_versions TO service_role;

-- TABLE: public.help_sessions
GRANT DELETE, INSERT, SELECT, UPDATE ON public.help_sessions TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.help_sessions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.help_sessions TO service_role;

-- TABLE: public.host_adapters
GRANT DELETE, INSERT, SELECT, UPDATE ON public.host_adapters TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.host_adapters TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.host_adapters TO service_role;

-- TABLE: public.host_booking_fee_configs
GRANT DELETE, INSERT, SELECT, UPDATE ON public.host_booking_fee_configs TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.host_booking_fee_configs TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.host_booking_fee_configs TO service_role;

-- TABLE: public.invitations
GRANT DELETE, INSERT, SELECT, UPDATE ON public.invitations TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.invitations TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.invitations TO service_role;

-- TABLE: public.legal_consents
GRANT DELETE, INSERT, SELECT, UPDATE ON public.legal_consents TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.legal_consents TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.legal_consents TO service_role;

-- TABLE: public.legal_documents
GRANT DELETE, INSERT, SELECT, UPDATE ON public.legal_documents TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.legal_documents TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.legal_documents TO service_role;

-- TABLE: public.messages
GRANT DELETE, INSERT, SELECT, UPDATE ON public.messages TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.messages TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.messages TO service_role;

-- TABLE: public.notifications
GRANT DELETE, INSERT, SELECT, UPDATE ON public.notifications TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.notifications TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.notifications TO service_role;

-- TABLE: public.payout_balances
GRANT DELETE, INSERT, SELECT, UPDATE ON public.payout_balances TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.payout_balances TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.payout_balances TO service_role;

-- TABLE: public.payout_records
GRANT DELETE, INSERT, SELECT, UPDATE ON public.payout_records TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.payout_records TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.payout_records TO service_role;

-- TABLE: public.pending_rag_sync
GRANT DELETE, INSERT, SELECT, UPDATE ON public.pending_rag_sync TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.pending_rag_sync TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.pending_rag_sync TO service_role;

-- TABLE: public.persona_addendums
GRANT DELETE, INSERT, SELECT, UPDATE ON public.persona_addendums TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.persona_addendums TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.persona_addendums TO service_role;

-- TABLE: public.pipeline_stages
GRANT DELETE, INSERT, SELECT, UPDATE ON public.pipeline_stages TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.pipeline_stages TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.pipeline_stages TO service_role;

-- TABLE: public.platform_revenue
GRANT DELETE, INSERT, SELECT, UPDATE ON public.platform_revenue TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.platform_revenue TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.platform_revenue TO service_role;

-- TABLE: public.platform_settings
GRANT DELETE, INSERT, SELECT, UPDATE ON public.platform_settings TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.platform_settings TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.platform_settings TO service_role;

-- TABLE: public.port_info_chunks
GRANT DELETE, INSERT, SELECT, UPDATE ON public.port_info_chunks TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.port_info_chunks TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.port_info_chunks TO service_role;

-- TABLE: public.pre_cruise_email_content
GRANT DELETE, INSERT, SELECT, UPDATE ON public.pre_cruise_email_content TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.pre_cruise_email_content TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.pre_cruise_email_content TO service_role;

-- TABLE: public.price_watches
GRANT DELETE, INSERT, SELECT, UPDATE ON public.price_watches TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.price_watches TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.price_watches TO service_role;

-- TABLE: public.pricing_cache
GRANT DELETE, INSERT, SELECT, UPDATE ON public.pricing_cache TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.pricing_cache TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.pricing_cache TO service_role;

-- TABLE: public.quotes
GRANT DELETE, INSERT, SELECT, UPDATE ON public.quotes TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.quotes TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.quotes TO service_role;

-- TABLE: public.rag_global_promotions
GRANT DELETE, INSERT, SELECT, UPDATE ON public.rag_global_promotions TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.rag_global_promotions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.rag_global_promotions TO service_role;

-- TABLE: public.rag_submissions
GRANT DELETE, INSERT, SELECT, UPDATE ON public.rag_submissions TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.rag_submissions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.rag_submissions TO service_role;

-- TABLE: public.reconciliation_review_queue
GRANT DELETE, INSERT, SELECT, UPDATE ON public.reconciliation_review_queue TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.reconciliation_review_queue TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.reconciliation_review_queue TO service_role;

-- TABLE: public.schema_migrations
GRANT DELETE, INSERT, SELECT, UPDATE ON public.schema_migrations TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.schema_migrations TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.schema_migrations TO service_role;

-- TABLE: public.security_incidents
GRANT DELETE, INSERT, SELECT, UPDATE ON public.security_incidents TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.security_incidents TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.security_incidents TO service_role;

-- TABLE: public.staging_cron_skips
GRANT DELETE, INSERT, SELECT, UPDATE ON public.staging_cron_skips TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.staging_cron_skips TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.staging_cron_skips TO service_role;

-- TABLE: public.stripe_webhook_events
GRANT DELETE, INSERT, SELECT, UPDATE ON public.stripe_webhook_events TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.stripe_webhook_events TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.stripe_webhook_events TO service_role;

-- TABLE: public.sub_host_subcontractors
GRANT DELETE, INSERT, SELECT, UPDATE ON public.sub_host_subcontractors TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.sub_host_subcontractors TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.sub_host_subcontractors TO service_role;

-- TABLE: public.subcontractors
GRANT DELETE, INSERT, SELECT, UPDATE ON public.subcontractors TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.subcontractors TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.subcontractors TO service_role;

-- TABLE: public.supervisor_review_queue
GRANT DELETE, INSERT, SELECT, UPDATE ON public.supervisor_review_queue TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.supervisor_review_queue TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.supervisor_review_queue TO service_role;

-- TABLE: public.tenant_branding
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_branding TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_branding TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_branding TO service_role;

-- TABLE: public.tenant_host_configs
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_host_configs TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_host_configs TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_host_configs TO service_role;

-- TABLE: public.tenant_host_fee_overrides
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_host_fee_overrides TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_host_fee_overrides TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_host_fee_overrides TO service_role;

-- TABLE: public.tenant_inactivity_nudges
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_inactivity_nudges TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_inactivity_nudges TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_inactivity_nudges TO service_role;

-- TABLE: public.tenant_override_requests
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_override_requests TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_override_requests TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_override_requests TO service_role;

-- TABLE: public.tenant_persona_overrides
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_persona_overrides TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_persona_overrides TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_persona_overrides TO service_role;

-- TABLE: public.tenant_rag_cap_events
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_rag_cap_events TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_rag_cap_events TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_rag_cap_events TO service_role;

-- TABLE: public.tenant_rag_quotas
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_rag_quotas TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_rag_quotas TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_rag_quotas TO service_role;

-- TABLE: public.tenant_settings
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_settings TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_settings TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_settings TO service_role;

-- TABLE: public.tenant_usage_metrics
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_usage_metrics TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_usage_metrics TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_usage_metrics TO service_role;

-- TABLE: public.tenant_usage_overrides
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_usage_overrides TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_usage_overrides TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_usage_overrides TO service_role;

-- TABLE: public.tenants
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenants TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenants TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenants TO service_role;

-- TABLE: public.tier_definitions
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tier_definitions TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tier_definitions TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tier_definitions TO service_role;

-- TABLE: public.usage_limit_events
GRANT DELETE, INSERT, SELECT, UPDATE ON public.usage_limit_events TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.usage_limit_events TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.usage_limit_events TO service_role;

-- TABLE: public.user_consent_pending
GRANT DELETE, INSERT, SELECT, UPDATE ON public.user_consent_pending TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.user_consent_pending TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.user_consent_pending TO service_role;

-- TABLE: public.user_data_export_requests
GRANT DELETE, INSERT, SELECT, UPDATE ON public.user_data_export_requests TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.user_data_export_requests TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.user_data_export_requests TO service_role;

-- TABLE: public.users
GRANT DELETE, INSERT, SELECT, UPDATE ON public.users TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.users TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.users TO service_role;

