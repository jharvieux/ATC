# Session state — last updated 2026-05-22 17:10 UTC

## Just completed

- BP20 — Forum-style group chat + booking flow schema scaffolding (§19–20)
  - Branch: feature/bp20-forum-booking
  - Forum schema migration (6 tables: forums, forum_threads, forum_messages, forum_reactions, forum_user_state, forum_strikes)
  - Booking flow migration (booking_passengers, booking_options, entry_point + 4 new status values)
  - permissions.ts, anonymity.ts, strikes.ts forum libs
  - Haiku fail-closed moderation endpoint with retry Inngest job + 24h timeout sweep
  - All coordinator tool endpoints (reactions, PATCH message/thread/user-state/forum)
  - dob-gate.ts, validation.ts booking libs
  - modify/route.ts correctly typed to HostAgencyClient interface
  - DOB gate wired into submit/route.ts
  - TenantOfRecordDisclosure.tsx component
  - Coordinator portal tabs at /groups/[id]/coordinate/[tab] (5 tabs)
  - No-anon booking guard (client-side redirect, TODO(supabase-ssr) for middleware promotion)
  - Booking flow UI stub at /booking/flow/[id]/[stage] (4 stages)
  - AI co-pilot panel placeholder TODO(prompt-24) slot
  - 7 new test files: permissions, anonymity, strikes, moderation retry idempotency, dob-gate, validation
  - MEMORY.md D-052 added
  - All tests pass (349/349), typecheck passes, lint passes, lint:migrations passes

## In flight

- Nothing in flight — BP20 committed but PR not yet opened

## Next step

- Open PR from feature/bp20-forum-booking → dev
- Wait for CI; merge if green
- Then proceed to BP21 — RAG consumer + 8-layer hallucination defense + quote pricing (§21)

## Blocked on user

- Apply all pending migrations to atc-main: `SUPABASE_DB_URL=<url> pnpm db:migrate`
  (includes BP19 migration: 20260529000000_groups.sql, and BP20: 20260530000000_forums.sql, 20260530000001_booking_flow.sql)
- Apply pending RAG migrations: 0007, 0008, 0009 psql to atc-rag
- Env vars to add to Vercel (atc-main):
  - INVITATION_TOKEN_HMAC_KEY (openssl rand -base64 32)
  - OPENAI_API_KEY (for DALL-E 3 group hero images)
  - VERCEL_API_TOKEN, VERCEL_PROJECT_ID, PLATFORM_PARENT_DOMAIN, PLATFORM_ENV
  - ANTHROPIC_API_KEY
  - HAIKU_FORUM_MODERATION_MODEL (default: claude-haiku-4-5-20251001)
  - HAIKU_NORMALIZATION_MODEL, HAIKU_PII_REDACTION_MODEL, ENTITY_EXTRACTION_MODEL
- Supabase Auth: enable Google, Microsoft, Facebook OAuth providers
- Redis (REDIS_URL) — provision Upstash
- STRIPE_PRICE_* env vars (16 total)
- STRIPE_TEST_SECRET_KEY GitHub secret

## Open questions

- Five supervisor preflight checks are stubs (D-046, will be implemented in BP21)
- Audit log → real INSERT when §26 lands (D-036)
- BrandedLayout: email send call sites being wired in BP23
- sub_host_subcontractors revenue dashboard deferred
- Forum invitee data loading and live forum component: TODO(prompt-24)
- No-anon guard should be promoted to middleware when @supabase/ssr installed: TODO(supabase-ssr)
- Slur deny-list must be populated by operator before launch (currently empty seed)
