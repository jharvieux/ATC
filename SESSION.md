# Session state — last updated 2026-05-22 21:00 UTC

## Just completed

- BP09 — RAG retrieval, ingest, approval, scope isolation (PR #42, squash-merged to `dev`)
  - §8.4 POST /api/retrieve: pgvector via match_knowledge_chunks() RPC, 4-score composite, scope filter, promo filter, rag_retrieval_log write
  - §8.5 POST /api/ingest: PII quarantine (422), clean → pending_review (200)
  - §8.6 POST /api/approve/tenant + /api/approve/global: queue promotion to knowledge_chunks with OpenAI embedding
  - §8.9 scope isolation integration test (6 cases, skips without ENABLE_RAG_INTEGRATION_TESTS=true)
  - PII regex-prefilter: passport/credit_card/SSN with Luhn + backreference separator (18 unit tests)
  - Migration 0008: contact_id on knowledge_chunks, submitted_by_user_id nullable, match_knowledge_chunks() RPC
  - Migration 0007 fix: DROP TABLE CASCADE to remove dangling FK
  - TODOs: §6-weighting-formula, §22.4-haiku-redaction
  - MEMORY.md D-044 logged

## In flight

- Nothing in flight — clean checkpoint. On `dev`, up to date with origin.

## Next step

1. **BP01–BP09 are all complete.**
2. Next: BP10 — AI Personas (§9): roster, prompts, tenant overrides, AI Mode + Background AI toggles.
   - Model: Sonnet 4.6 (already active)
   - Read the BP10 section of `specs/BuildPrompts/build-prompts-part-3.md` before starting.

## Blocked on user

- **Apply pending RAG migrations** before live traffic:
  - atc-rag: `0007_tenant_registry_shadow.sql`, `0008_retrieval_function_and_schema_fixes.sql`
  - Command: `SUPABASE_DB_URL=<atc-rag pooler URL> MIGRATIONS_DIR=apps/rag/supabase/migrations pnpm db:migrate`
- **Apply pending main app migrations** before live traffic:
  - atc-main: `20260521190000_tenant_source_revision.sql`, `20260521200000_pending_rag_sync.sql`
  - Command: `SUPABASE_DB_URL=<atc-main pooler URL> pnpm db:migrate`
- **Redis (REDIS_URL)** — provision Upstash or similar; add to Vercel env vars for atc-rag and `.env.local`
- **Vercel env vars to add** (atc-rag): `OPENAI_API_KEY`, `SUPABASE_RAG_ANON_KEY`, plus all BP08 vars
- `STRIPE_TEST_SECRET_KEY` repo secret — carry-over from D-023
- `PLATFORM_DOMAIN_REGEX` Vercel env var for atc-main — carry-over from BP04

## Open questions

- §6-weighting-formula in match_knowledge_chunks() — equal weights until spec is finalised (D-044)
- §22.4-haiku-redaction in /api/ingest — tolerable PII pass deferred (D-044)
- Stripe event handlers are all TODO stubs (§14, §16 work) — D-042
- platform_settings sync (D-041) — replica updated manually until sync lands
- Deferred FKs from BP05: contacts, personas, group_bookings — D-040
- audit_log stub → real INSERT when §26 lands (D-036)
- tenantClient Proxy: .rpc() not intercepted (D-034)
- deploy.yml: singular VERCEL_PROJECT_ID (atc-main only) — D-030
