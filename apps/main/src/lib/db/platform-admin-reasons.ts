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

  // Forensics access
  "forensics_log_review",

  // Customer chat caps (per §24.9)
  "customer_chat_cap_override",

  // Feedback settings (per §6.10)
  "feedback_settings_change",

  // Catch-all for emergencies (use sparingly — must be paired with
  // an audit_log.changes.reason_detail string and a MEMORY.md entry)
  "manual_emergency_intervention",
] as const;

export type PlatformAdminReason = (typeof PLATFORM_ADMIN_REASONS)[number];
