# Session state — last updated 2026-05-21

## Just completed

- BP06 — RAG service schema landed (PR #35, squash-merged to `dev`)
  - 6 RAG migrations (apps/rag/supabase/migrations/): pgvector + tenant_registry, knowledge_chunks with VECTOR(1536), ingestion queue + retrieval log, expected_promo_state() IMMUTABLE SQL function (§6.7), compute_feedback_factor() STABLE plpgsql (§6.10), platform_settings replica (option C)
  - Main app: canonical platform_settings table with RLS + 4-knob seed (§6.10)
  - apps/rag/src/lib/env.ts: SUPABASE_RAG_* naming (avoids .env.local collision)
  - scripts/db-migrate.ts: MIGRATIONS_DIR env override for RAG migrations
  - apps/rag/db/rls-snapshot.sql: documents intentional no-RLS exception
  - apps/rag/README.md: scope, schema overview, tenant isolation, replication choice
  - db/rls-snapshot.sql: regenerated (includes platform_settings_select_policy)
  - MEMORY.md D-041 logged (platform_settings cross-project decision)

## In flight

- Nothing in flight — clean checkpoint. On `dev`, up to date with origin.

## Next step

1. **Next build prompt:** BP07 — API route scaffold + Stripe webhook contract
   - Model: `claude-opus-4-7` (build prompt requires Opus — switch at start)
   - Read `specs/BuildPrompts/build-prompts-parts-1-and-2.md` BP07 section before starting
   - Prerequisites: BP02–BP06 committed ✓
   - Switch back to `claude-sonnet-4-6` at end of BP07

## Blocked on user

- `STRIPE_TEST_SECRET_KEY` repo secret — still needed for contracts-canary nightly re-record (carry-over from D-023)
- **Manual follow-up from BP04:** Add `PLATFORM_DOMAIN_REGEX` to Vercel environment variables for `atc-main` (preview + production). Value: `^([a-z0-9-]+)\.ai-travelconcierge\.com$`
- **Platform_settings sync (D-041):** Nightly sync job + on-change webhook from main app to RAG replica not yet implemented — update RAG replica manually after any feedback knob change

## Open questions

- Deferred FKs from BP05: contacts, personas, group_bookings tables not yet created; TODO comments in migrations (D-040)
- Full list of remaining §5.3 tables not yet migrated: contacts, contact_relationships, quotes, group_bookings, group_members, group_invitations, group_chat_threads, group_chat_messages, personas, tenant_persona_overrides, tenant_branding, host_adapters, tenant_host_configs, host_adapter_calls, escalation_topics, supervisor_alerts, audit_log, email_log, email_suppressions, legal_documents, legal_consents, platform_revenue, customer_memories, news_articles, destination_images, generated_images, pre_cruise_email_content
- `audit_log` table stub (D-036): swap `writeAuditRow` in `platform-admin-client.ts` to real INSERT when §26 lands; also swap `correlation_id` to ULID at same time (D-035)
- `tenantClient` Proxy: `.rpc()` and other patterns not yet intercepted (D-034). Extend when first used
- Migration lint gate does not enforce "every tenant-scoped table must have GRANTs for `authenticated` AND `service_role`" (D-032, D-039). Worth adding when next round of migration tooling lands
- `deploy.yml` singular `VERCEL_PROJECT_ID` (atc-main only) — split deferred to BP07 (D-030)
- RLS snapshot scope: §30.8 coverage for SECURITY DEFINER bodies + GRANT/REVOKE EXECUTE deferred (D-033)
- `.env.example` uses `RAG_SUPABASE_*` naming while `.env.local` uses `SUPABASE_RAG_*` — reconcile when convenient
