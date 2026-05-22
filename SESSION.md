# Session state — last updated 2026-05-22 20:00 UTC

## Just completed

- BP08 — RAG service security backbone (PR #39, squash-merged to `dev`)
  - §8.3 fail-closed JWT verifier: RS256 + kid allowlist, ioredis jti replay check (503 if Redis down), tenant shadow lookup (403 if unknown/inactive)
  - `withServiceAuth` HOC for RAG API routes
  - ioredis singleton client (`lazyConnect: true`, `maxRetriesPerRequest: 1`)
  - HMAC-SHA256 tenant-events webhook + stale revision check
  - RAG sync publisher (`publish-tenant-event.ts`): 3-retry with backoff, fallback to `pending_rag_sync`
  - Inngest jobs: `ragSyncRetry` (*/5 min), `ragSyncCleanup` (0 4 daily), nightly `tenantRegistryReconcile` (0 3 *)
  - Platform admin endpoint `/api/admin/tenants` (bearer-auth, for RAG reconcile)
  - Migrations: `source_revision` BEFORE UPDATE trigger on `tenants` (atc-main), `pending_rag_sync` retry queue with partial index
  - `tenant_registry_shadow`: drops old BP06 `tenant_registry`, recreates with §8.3 shape
  - 9 JWT unit tests (all pass): 2×missing_token, 2×signature_invalid, expired, redis_unreachable, tenant_unknown, tenant_inactive, success
  - `apps/rag/vitest.config.ts` created; root vitest.config.ts updated to exclude RAG tests
  - `.gitleaks.toml` created: allowlist for `.github/workflows/` CI placeholder values
  - CI env var placeholders added for all BP08 vars
  - MEMORY.md D-043 logged

## In flight

- Nothing in flight — clean checkpoint. On `dev`, up to date with origin.

## Next step

1. **BP01–BP08 are all complete.**
2. Apply pending migrations before live traffic:
   - atc-main: `20260521190000_tenant_source_revision.sql`, `20260521200000_pending_rag_sync.sql`
   - atc-rag: `0007_tenant_registry_shadow.sql`
3. Read the next build prompt file for the next batch of work.

## Blocked on user

- `REDIS_URL` — needs a Redis instance provisioned (Upstash recommended) and added to Vercel env vars for `atc-rag` + `.env.local`
- `MAIN_APP_ADMIN_API_KEY` — generated value needs to be in both `.env.local` (for RAG service) and Vercel env vars for `atc-rag`
- Pending migrations must be applied to both Supabase projects (can run `pnpm db:migrate` when `SUPABASE_DB_URL` is set)
- **Vercel env vars to add** (atc-main): `SERVICE_JWT_PRIVATE_KEY`, `SERVICE_JWT_KEY_ID`, `RAG_SERVICE_URL`, `RAG_WEBHOOK_SECRET`
- **Vercel env vars to add** (atc-rag): `SERVICE_JWT_PUBLIC_KEY`, `SERVICE_JWT_ACCEPTED_KEY_IDS`, `REDIS_URL`, `MAIN_APP_URL`, `MAIN_APP_ADMIN_API_KEY`, `RAG_WEBHOOK_SECRET`, `SUPABASE_RAG_URL`, `SUPABASE_RAG_SERVICE_ROLE_KEY`
- `STRIPE_TEST_SECRET_KEY` repo secret — still needed for contracts-canary nightly re-record (carry-over from D-023)
- **Manual follow-up from BP04:** Add `PLATFORM_DOMAIN_REGEX` to Vercel env vars for `atc-main`. Value: `^([a-z0-9-]+)\.ai-travelconcierge\.com$`
- **Platform_settings sync (D-041):** Nightly sync job + on-change webhook from main app to RAG replica not yet implemented

## Open questions

- Stripe event handlers are all TODO stubs (§14, §16 work to follow) — see D-042
- Inngest escalation is log-only (TODO(escalation) in reconcile job) — real alerts deferred
- Deferred FKs from BP05: contacts, personas, group_bookings tables not yet created (D-040)
- Full list of remaining §5.3 tables: contacts, contact_relationships, quotes, group_bookings, group_members, group_invitations, group_chat_threads, group_chat_messages, personas, tenant_persona_overrides, tenant_branding, host_adapters, tenant_host_configs, host_adapter_calls, escalation_topics, supervisor_alerts, audit_log, email_log, email_suppressions, legal_documents, legal_consents, platform_revenue, customer_memories, news_articles, destination_images, generated_images, pre_cruise_email_content
- `audit_log` table stub (D-036): swap `writeAuditRow` to real INSERT when §26 lands (also swap correlation_id to ULID per D-035)
- `tenantClient` Proxy: `.rpc()` not yet intercepted (D-034)
- Migration lint gate doesn't enforce GRANTs for authenticated + service_role (D-032, D-039)
- `deploy.yml` singular `VERCEL_PROJECT_ID` (atc-main only) — split deferred (D-030)
- RLS snapshot scope: §30.8 SECURITY DEFINER + GRANT coverage deferred (D-033)
