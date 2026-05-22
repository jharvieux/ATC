# Session state — last updated 2026-05-22 18:45 UTC

## Just completed

- BP21 — RAG consumer side, eight-layer hallucination defense, quote pricing discipline (§21) — MERGED to dev as PR #64 (commit 3ece605)
  - Branch: feature/bp21-rag-consumer-hallucination-quotes (deleted post-merge)
  - Migration 20260531000000_quote_pricing.sql:
    - quotes: price_kind, price_lock_token, price_lock_expires_at, customer_accepted_variance_cents, customer_accepted_at, customer_accepted_audit_id, priced_at, estimate_price_cents, locked_price_cents
    - NEW tenant_settings table (quote_variance_cents, show_chat_sources)
    - platform_settings seed: quote_estimate_validity_days=7, category_halflives_days
  - RAG consumer pipeline:
    - entity-extraction.ts (Haiku, 1s timeout, 1h cache, empty-set fallback)
    - chunk-types.ts, filter-chunks.ts (floor, expiry, closed-promo, pricing-cap, dedup, topN)
    - format-block.ts (§21.4 verbatim, ★ rating, AUTHORITATIVE_OVERRIDE tag, no-result block)
    - retrieve-for-chat.ts (orchestrator with RAG service call)
  - Persona prompt integration: knowledge_block param flows through buildSystemPrompt
  - MessageSources.tsx component (§21.6 click-to-expand source UI)
  - All 5 BP11 supervisor preflight stubs filled:
    - hallucination_risk (Haiku claim extraction + chunk keyword grounding)
    - arithmetic_check (deterministic parser + LTR eval + tolerance)
    - topic_escalation (= §21.10 layer 8 escalation safety net)
    - persona_drift v1 (model-self-ref + unknown-name + refusal detection)
    - compliance_keyword (deterministic regex for med/legal/financial advice)
  - run-supervisor.ts updated: async checks via Promise.all, extras passthrough
  - supervisor/metrics.ts (§21.10 defense metric emitter — console.warn stub)
  - Quote pricing discipline:
    - kind-resolver.ts (15-min freshness + price_lock_token + adapter capability)
    - render-pdf.ts (estimate/confirmed HTML serialization, audit-snapshot ready)
    - /api/quotes/[id]/accept rewritten: variance recording + PDF snapshot + audit_id
    - /api/bookings/[id]/submit extended: §21.10.1 variance branch → pending_customer_reconfirmation
    - quote-estimate-expiry-sweep.ts (daily 02:00 UTC Inngest cron)
  - HostCapabilities: supports_price_lock added (defaulted false on existing adapters)
  - HostAgencyClient: getCurrentPrice added as OPTIONAL method
  - 8 new test files, 63 new unit tests
  - All tests pass (397/397 non-skipped), typecheck passes, lint passes, lint:migrations passes
  - MEMORY.md D-053 added

## In flight

- Nothing in flight — clean checkpoint

## Next step

- Proceed to BP22 — RAG ingestion: normalization, PII zero-tolerance, four-tab global review (§22). Uses Opus per build prompt.

## Blocked on user

- Apply BP21 migration to atc-main: `SUPABASE_DB_URL=<url> pnpm db:migrate`
  (includes 20260531000000_quote_pricing.sql plus any prior unapplied)
- Apply pending RAG migrations: 0007, 0008, 0009 psql to atc-rag
- Env vars to add to Vercel (atc-main) for BP21:
  - ANTHROPIC_API_KEY (entity extraction + hallucination_risk claim check)
  - ENTITY_EXTRACTION_MODEL (default: claude-haiku-4-5-20251001)
  - RAG_CHUNK_CONFIDENCE_FLOOR (default 0.35)
  - RAG_CHUNK_DEDUP_SIMILARITY_THRESHOLD (default 0.8)
  - RAG_CHUNK_TOP_N_DEFAULT (default 4)
  - QUOTE_PDF_RENDERER (default react-pdf)
  - QUOTE_ESTIMATE_VALIDITY_DAYS (default 7)
  - QUOTE_DEFAULT_VARIANCE_CENTS (default 5000)
- Carry-over from BP20:
  - INVITATION_TOKEN_HMAC_KEY, OPENAI_API_KEY (DALL-E 3)
  - HAIKU_FORUM_MODERATION_MODEL, HAIKU_NORMALIZATION_MODEL, HAIKU_PII_REDACTION_MODEL
  - VERCEL_API_TOKEN, VERCEL_PROJECT_ID, PLATFORM_PARENT_DOMAIN, PLATFORM_ENV
  - Supabase Auth: enable Google, Microsoft, Facebook OAuth
  - Redis (REDIS_URL) — Upstash
  - STRIPE_PRICE_* env vars (16 total)
  - STRIPE_TEST_SECRET_KEY GitHub secret

## Open questions

- Quote PDF binary rendering: react-pdf wiring deferred (HTML serialization is the audit snapshot for now)
- hallucination_risk claim-extraction Haiku prompt has no recorded contract tests yet — gated by ANTHROPIC_API_KEY
- Persona-drift v1 catches deterministic patterns; richer Haiku voice-comparison is a follow-up
- BrandedLayout email send call sites wiring is BP23
- Forum invitee data loading and live forum component: TODO(prompt-24)
- No-anon guard middleware promotion when @supabase/ssr installed: TODO(supabase-ssr)
- Slur deny-list must be populated by operator before launch (currently empty seed)
- audit_log table real-INSERT swap when §26 lands (D-036, D-053 stub)
- BP21 RAG service /retrieve auth uses simple Bearer; RS256 JWT signing per BP09 is TODO(bp24-chat-service-jwt)
