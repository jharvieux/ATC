// Spec ref: §5.4.8
//
// The complete set of allowed reasons for platform-admin operations.
// Adding a value to this enum is a deliberate act that affects audit
// query patterns and forensic vocabulary. Reviewed quarterly per §26.11.
//
// Forensic investigations against audit_log filter on
// `action = 'platformAdmin.<reason>'`, so a closed enum keeps that filter
// predictable. Free-text reasons drift (three spellings for one operation);
// the enum eliminates that. New reasons require a PR + reviewer.

export const PLATFORM_ADMIN_REASONS = [
  // Tenant lifecycle
  "tenant_listing_for_admin_dashboard",
  "tenant_detail_lookup",
  "tenant_status_change",
  "tenant_termination_processing",
  "tenant_suspension_processing",

  // RAG content moderation
  "rag_chunk_promotion_to_global",
  "rag_chunk_demotion",
  "rag_quarantined_content_review",

  // Commission disputes & overrides
  "commission_dispute_review",
  "commission_manual_override",
  "commission_reconciliation_audit",

  // Abuse monitoring
  "abuse_threshold_breach_review",
  "abuse_signal_aggregation",

  // Bug submission triage
  "bug_submission_review",
  "auto_fix_pipeline_audit",

  // Help docs ingestion
  "help_doc_publishing",
  "help_doc_rag_sync",

  // Privacy & compliance
  "ccpa_export_processing",
  "ccpa_deletion_processing",
  "gdpr_export_processing", // future use, reserved

  // Health and monitoring
  "cross_tenant_health_aggregation",
  "platform_metrics_rollup",

  // Platform-wide knob changes (e.g. integration rate-limits, vendor caps).
  // Kept distinct from feedback_settings_change which scopes to §6.10's
  // retrieval-feedback knobs.
  "platform_setting_update",

  // Forensics access
  "forensics_log_review",

  // Customer chat caps (per §24.9)
  "customer_chat_cap_override",

  // Feedback settings (per §6.10)
  "feedback_settings_change",

  // BP22 §6 — retrieval composite-weight knobs in platform_settings
  // (match/authority/recency exponents + feedback coefficient).
  "retrieval_weights_change",

  // AI Supervisor kill switch (§10.6)
  "ai_kill_switch_global_pause",
  "ai_kill_switch_global_resume",
  "ai_kill_switch_tenant_pause",
  "ai_kill_switch_tenant_resume",

  // Onboarding review actions (§15.11)
  "onboarding_review_action",

  // Cross-tenant administrative queries (§15.11 review queue)
  "cross_tenant_admin",

  // Catch-all for emergencies (use sparingly — must be paired with
  // an audit_log.changes.reason_detail string and a MEMORY.md entry)
  "manual_emergency_intervention",

  // Deny-list quarterly review / additions / removals (per §24.5 / §26.11).
  "denylist_management",

  // SaaS abuse override workflow (§27.11 / §27.14).
  "abuse_override_create",
  "abuse_override_revoke",
  "abuse_override_request_review",

  // Self-Service Help triage (§32.6.5).
  "help_admin_view",
  "help_feature_decision",

  // BP35 §33.4 — CruiseMapper itinerary refresh (cross-tenant reference data).
  "external_pricing_refresh",

  // §27.12 — Operator-managed AI vendor pricing catalog.
  "ai_pricing_read",
  "ai_pricing_update",

  // Resource utilization dashboard — Resend per-email cost rate + Apify budget cap.
  "resend_pricing_update",
  "apify_budget_update",

  // §33.12 — Authority-override curation (platform admin sets or clears
  // authority_manual_override on knowledge_chunks).
  "rag_authority_curation",

  // #489 — Platform admin test-delivery for email design review.
  "admin_email_sample_preview",
  "admin_email_sample_send",

  // D-138 §9.3 — DB-backed persona config + editable safety block editing.
  "persona_config_read",
  "persona_config_update",
  "persona_config_restore",
  "persona_safety_update",
  "persona_safety_restore",

  // #692 — Nightly cron that reconciles RAG embedding cost into
  // tenant_usage_metrics.ai_cost_cents. Distinct from platform_metrics_rollup
  // because it touches tenant-scoped billing state, not aggregate metrics.
  "rag_cost_reconciliation",

  // §TN — Travel news feed + article management.
  "travel_news_feeds_read",
  "travel_news_feed_create",
  "travel_news_feed_update",
  "travel_news_feed_delete",
  "travel_news_manual_refresh",
  "travel_news_articles_read",
  "travel_news_article_hide",
  "travel_news_article_unhide",
  "travel_news_article_rag_submit",
] as const;

export type PlatformAdminReason = (typeof PLATFORM_ADMIN_REASONS)[number];
