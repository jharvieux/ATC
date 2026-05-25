// Tables NOT in this set are NOT auto-filtered by `tenantClient`.
//
// Adding a new tenant-scoped table requires:
//   1. Adding it here, AND
//   2. Adding the four RLS policies per spec §5.1.2 (SELECT/INSERT/UPDATE/DELETE).
//
// Both happen in the same PR. The migration-lint gate (§30.8) blocks the
// table-creation migration if RLS coverage is missing; the unit tests
// here catch the case where a developer adds RLS but forgets the set entry,
// which would let a query escape the proxy's tenant_id filter.
//
// FAIL-CLOSED CONTRACT (added 2026-05-25 after the security audit):
//   `tenantClient(ctx).from(table)` THROWS if `table` is in neither
//   `TENANT_SCOPED_TABLES` nor `PLATFORM_READABLE_TABLES`. This forces a
//   deliberate decision at the call site instead of silently dropping to
//   raw service-role access, which previously created cross-tenant data
//   leaks (e.g., `GET /api/tasks` returned every tenant's tasks until
//   `tasks` was added to this list).
//
// Tables listed here that don't exist yet (most of them, until §5.3 lands)
// are intentional — the central list is easier to maintain than scattered
// per-table allowlists. The proxy's .has() check is O(1) regardless.

export const TENANT_SCOPED_TABLES: ReadonlySet<string> = new Set([
  "users",
  "conversations",
  "messages",
  "bookings",
  "commissions",
  "subcontractors",
  "payout_balances",
  "payout_records",
  "stripe_webhook_events",
  "tenant_persona_overrides",
  "escalation_topics",
  "customer_memories",
  "anonymous_sessions",
  "contacts",
  "contact_relationships",
  "pipeline_stages",
  "quotes",
  "tenant_host_fee_overrides",
  "tenant_host_configs",
  "platform_revenue",
  "sub_host_subcontractors",
  "tenant_branding",
  "persona_addendums",
  // BP19: Group bookings (§18)
  "groups",
  "invitations",
  // BP20: Forum (§19) + booking flow (§20)
  "forums",
  "forum_threads",
  "forum_messages",
  "forum_reactions",
  "forum_user_state",
  "forum_strikes",
  "booking_passengers",
  "booking_options",
  // BP40: price-watch subscriptions (§33.8)
  "price_watches",
  // 2026-05-25 audit catch-up — every table with the 4-policy RLS set
  // (per db/rls-snapshot-main.sql) that's reachable via tenantClient.
  // Over-inclusion is fine: tables in here that lack a tenant_id column
  // are blocked at the DB layer (the auto-injected filter returns 0 rows
  // or RLS rejects the write). Under-inclusion is the security risk.
  "tasks",                            // BP37 §37
  "task_reminders",                   // BP37 §37
  "task_sequences",                   // BP37
  "task_sequence_steps",              // BP37
  "task_sequence_runs",               // BP37
  "quote_options",                    // BP38 §38
  "booking_line_items",               // BP40 §40.5
  "campaigns",                        // BP35 attribution
  "attribution_rollup",               // BP36 — materialized view, reads only
  "attribution_touches",              // BP35 §35.6
  "tenant_attribution_categories",    // BP35
  "notifications",                    // in-app notifications
  "tenant_settings",                  // tenant-scoped settings
  "tenant_usage_metrics",             // BP27/BP28 usage tracking
  "tenant_usage_overrides",           // BP28 manual overrides
  "tenant_override_requests",         // BP28
  "tenant_rag_quotas",                // RAG quotas
  "tenant_rag_cap_events",            // RAG cap events
  "tenant_inactivity_nudges",         // inactivity nudges
  "customer_chat_tenant_overrides",   // BP24 chat limits
  "customer_chat_counters",           // BP24 counters
  "customer_bug_submission_counters", // §32 customer bug counters
  "anonymous_chat_counters",          // BP24 anonymous rate
  "rag_submissions",                  // RAG tenant submissions
  "rag_global_promotions",            // RAG global promotions (per-tenant promote)
  "help_sessions",                    // §32 self-service help
  "help_doc_versions",                // BP31 help docs
  "bug_submissions",                  // §32 help
  "feature_requests",                 // §32 help
  "complaints",                       // tenant complaints
  "import_queue",                     // BP34 inbound import
  "contact_imports",                  // BP34
  "trip_itineraries",                 // BP39
  "trip_resources",                   // BP39
  "pre_cruise_email_content",         // pre-cruise email content
  "email_suppressions",               // tenant email suppression list
  "legal_consents",                   // tenant consent records
  "legal_documents",                  // tenant legal docs (versioned per spec)
  "audit_log",                        // tenant audit log (writes service-role only)
  "auth_attempts",                    // tenant auth attempt log
  "abuse_signals",                    // BP27/28 abuse signals
  "abuse_recompute_drift_log",        // BP28 abuse recompute drift
  "ai_call_log",                      // tenant AI call audit
  "ccpa_deletion_executions",         // CCPA deletion execution log
  "forensics_log",                    // tenant forensics log (writes service-role only)
  "security_incidents",               // tenant security incidents
  "staging_cron_skips",               // staging cron skip tracking
  "usage_limit_events",               // BP27/28 usage limit events
  "group_invite_pending_approval",    // BP19 group invite approvals
]);

// PLATFORM_READABLE_TABLES — accessible via tenantClient WITHOUT auto-scoping.
//
// These tables either:
//   (a) have no `tenant_id` column (platform catalogs like tier_definitions,
//       host_adapters), OR
//   (b) use the tenant id as their primary key (the `tenants` table itself —
//       callers self-scope with `.eq("id", ctx.tenant_id)`), OR
//   (c) are platform-internal logs intentionally accessed cross-tenant
//       (email_log, pricing_cache).
//
// Reads/writes through tenantClient on these tables are PASSED THROUGH
// without modification — callers MUST apply their own filter. Adding a
// table here is a deliberate security decision; review the call sites
// carefully before adding.
//
// To enforce: `tenantClient(ctx).from(table)` returns the raw service-role
// query builder for tables in this set. RLS is NOT in play (service-role
// bypasses it), so caller-side scoping is the only defense.
export const PLATFORM_READABLE_TABLES: ReadonlySet<string> = new Set([
  // The `tenants` table itself — its primary key IS the tenant id. Routes
  // that fetch a tenant by id always do `.eq("id", ctx.tenant_id)`.
  "tenants",
  // Platform catalogs (no tenant_id column) — see db/rls-exceptions.txt.
  "tier_definitions",
  "host_adapters",
  "host_booking_fee_configs",
  "pricing_cache",
  // Platform-wide settings (no tenant_id, singleton-ish rows).
  "platform_settings",
  "ai_kill_switch_state",
  // Cross-tenant log — service-role-only writes from cron paths, reads via
  // platform-admin audit. tenant_id is nullable.
  "email_log",
]);
