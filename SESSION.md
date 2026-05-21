# Session state — last updated 2026-05-21

## Just completed

- BP05 — Core domain schema landed (PR #33, squash-merged to `dev`)
  - `20260521150000_conversations_messages.sql`: conversations + messages, read-only-after-suspension RLS, deferred FKs for contact_id/active_persona_id/persona_id
  - `20260521160000_bookings_commissions.sql`: booking_status + commission_status enums, bookings + commissions + subcontractors, standard four-policy RLS, money columns annotated `-- cents per §14.0.1`, deferred FKs for primary_contact_id/group_booking_id
  - `20260521170000_payouts_and_webhook_dedup.sql`: payout_balances + payout_records (standard RLS), stripe_webhook_events (custom SELECT-only RLS, documented in db/rls-exceptions.txt)
  - All migrations include GRANTs for authenticated + service_role
  - `db/rls-snapshot.sql` regenerated (10 tables with RLS)
  - `rls.test.ts`: 11 new BP05 tests (15 total, all pass)
  - MEMORY.md D-040 logged

## In flight

- Nothing in flight — clean checkpoint. On `dev`, up to date with origin.

## Next step

1. **Next build prompt:** BP06 — RAG schema and vector search (§6)
   - Model: `claude-sonnet-4-6` (already on Sonnet — no switch needed)
   - Read `specs/BuildPrompts/build-prompts-parts-1-and-2.md` BP06 section before starting
   - Prerequisites: BP02–BP05 committed ✓

## Blocked on user

- `STRIPE_TEST_SECRET_KEY` repo secret — still needed for contracts-canary nightly re-record (carry-over from D-023)
- **Manual follow-up from BP04:** Add `PLATFORM_DOMAIN_REGEX` to Vercel environment variables for `atc-main` (preview + production). Value: `^([a-z0-9-]+)\.ai-travelconcierge\.com$`

## Open questions

- Deferred FKs from BP05: contacts, personas, group_bookings tables not yet created; TODO comments in migrations (D-040)
- Full list of remaining §5.3 tables not yet migrated: contacts, contact_relationships, quotes, group_bookings, group_members, group_invitations, group_chat_threads, group_chat_messages, personas, tenant_persona_overrides, tenant_branding, host_adapters, tenant_host_configs, host_adapter_calls, escalation_topics, supervisor_alerts, audit_log, email_log, email_suppressions, legal_documents, legal_consents, platform_revenue, customer_memories, news_articles, destination_images, generated_images, pre_cruise_email_content
- `audit_log` table stub (D-036): swap `writeAuditRow` in `platform-admin-client.ts` to real INSERT when §26 lands; also swap `correlation_id` to ULID at same time (D-035)
- `tenantClient` Proxy: `.rpc()` and other patterns not yet intercepted (D-034). Extend when first used
- Migration lint gate does not enforce "every tenant-scoped table must have GRANTs for `authenticated` AND `service_role`" (D-032, D-039). Worth adding when next round of migration tooling lands
- `deploy.yml` singular `VERCEL_PROJECT_ID` (atc-main only) — split deferred to BP07 (D-030)
- RLS snapshot scope: §30.8 coverage for SECURITY DEFINER bodies + GRANT/REVOKE EXECUTE deferred (D-033)
- `.env.example` uses `RAG_SUPABASE_*` naming while `.env.local` uses `SUPABASE_RAG_*` — reconcile in BP06
- All prior open questions: `email_connections` schema, CODEOWNERS backup reviewer, rollback runbook screenshots, §12 eval harness deferral
