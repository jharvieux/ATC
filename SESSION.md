# Session state — last updated 2026-05-22 22:00 UTC

## Just completed

- BP10 — AI Personas (§9): roster, prompts, AI Mode + Background AI toggles (PR #44, squash-merged to `dev`)
  - 6 persona base-blocks with full real backstories from Agent Backstories Photo Guide v2.docx
    - marcus-cole (Caribbean + CATCHALL), marco-bellini (Mediterranean/Rivers), priya-sharma (Luxury),
      captain-dave (Alaska/Adventure), maya-patel (Accessible Travel), jenny-hartwell (Family Cruising)
  - System prompt builder (§9.3): three-layer architecture + Anthropic prompt-cache key
  - Platform constraints block (§9.3/§9.7): disclosure, prohibited topics, escalation
  - tenant_persona_overrides table + RLS (migration 20260522100000)
  - ai_mode + background_ai_enabled columns on tenants (migration 20260522110000)
  - resolveAIBehavior (§9.10.1): full 2×3 flag matrix, 44 unit tests
  - upsertPersonaOverride: tier-gating + Haiku screening, 10 unit tests
  - Haiku screening (screen-addendum.ts): fail-closed, first-draft prompt
  - Tool-use registry stubs: 6 tools per §9.6
  - API routes: GET/PATCH /api/tenant/ai-config, GET /api/tenant/personas, PATCH /api/tenant/personas/[slug]
  - /settings/ai-mode UI: 3 mode cards + disabled coverage table + Background AI toggle + confirm dialog
  - Switch and Dialog shadcn components
  - MEMORY.md D-045 logged

## In flight

- Nothing in flight — clean checkpoint. On `dev`, up to date with origin.

## Next step

1. **BP01–BP10 are all complete.**
2. Next: BP11 — AI Supervisor (§10): regen budget, preflight skeleton, escalation topics, review queue, kill switch.
   - Model: Sonnet 4.6 (already active)
   - Read the BP11 section of `specs/BuildPrompts/build-prompts-part-3.md` before starting.

## Blocked on user

- **Apply pending migrations to atc-main before live traffic:**
  - `20260522100000_tenant_persona_overrides.sql`
  - `20260522110000_tenant_ai_mode.sql`
  - Also still pending from BP09: `20260521190000_tenant_source_revision.sql`, `20260521200000_pending_rag_sync.sql`
  - Command: `SUPABASE_DB_URL=<atc-main pooler URL> pnpm db:migrate`
- **Apply pending RAG migrations** (carry-over from BP09):
  - atc-rag: `0007_tenant_registry_shadow.sql`, `0008_retrieval_function_and_schema_fixes.sql`
  - Command: `SUPABASE_DB_URL=<atc-rag pooler URL> MIGRATIONS_DIR=apps/rag/supabase/migrations pnpm db:migrate`
- **Add ANTHROPIC_API_KEY to Vercel env vars for atc-main** (needed for Haiku screening in production)
- **Avatar images**: generate using prompts in `specs/Agent Backstories Photo Guide v2.docx`, upload to Supabase Storage, update agents table (table not yet created — lands in a later prompt)
- **Redis (REDIS_URL)** — provision Upstash or similar; add to Vercel env vars for atc-rag and `.env.local`
- **Vercel env vars to add** (atc-rag): `OPENAI_API_KEY`, `SUPABASE_RAG_ANON_KEY`, plus all BP08 vars
- `STRIPE_TEST_SECRET_KEY` repo secret — carry-over from D-023
- `PLATFORM_DOMAIN_REGEX` Vercel env var for atc-main — carry-over from BP04

## Open questions

- Haiku screening prompt in screen-addendum.ts is first-draft — operator review recommended before launch (D-045)
- §6-weighting-formula in match_knowledge_chunks() — equal weights until spec finalised (D-044)
- §22.4-haiku-redaction in /api/ingest — tolerable PII pass deferred (D-044)
- Stripe event handlers are all TODO stubs (§14, §16 work) — D-042
- platform_settings sync (D-041) — replica updated manually until sync lands
- Deferred FKs from BP05: contacts, personas, group_bookings — D-040
- audit_log stub → real INSERT when §26 lands (D-036)
- tenantClient Proxy: .rpc() not intercepted (D-034)
- deploy.yml: singular VERCEL_PROJECT_ID (atc-main only) — D-030
