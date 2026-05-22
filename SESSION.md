# Session state — last updated 2026-05-22 19:00 UTC

## Just completed

- BP15 — Commissions, Splits & Payouts (§14): PR #53 merged to dev (all CI checks green, squash merge)
  - Migration: tier_definitions columns, platform_revenue, sub_host_subcontractors, reconciliation_review_queue, payout_records extensions
  - lib/money.ts: Cents/NumericRate brand types, big.js arithmetic, NegativeMoneyError, assertSafeStripeAmount
  - ESLint rule atc/no-money-math
  - lib/commissions/state-machine.ts: full §14.2 state machine
  - POST /api/bookings/:id/submit: fail-closed §14.4, locked rates, commissions row
  - POST /api/bookings/:id/cancel: §14.9 clawback logic
  - 4 Inngest payout jobs (split-on-received, mark-available, execute-transfer, reconcile-processing)
  - inngest/reconcile-statement-automated.ts: daily cron §14.8
  - Admin reconciliation upload (Haiku-parse CSV) + queue routes
  - CRUD /api/subcontractors + subcontractors settings page (sub_host only)
  - lib/stripe/price-ids.ts
  - docs/runbooks/year-end-1099.md
  - 68 new unit tests (money: 31, state machine: 37); 210 total, 0 regressions
  - MEMORY.md D-048 added

## In flight

- Nothing in flight — clean checkpoint

## Next step

1. Begin BP16 — Tenant Onboarding & Compliance (§15): 12-stage onboarding state machine, schema, sandbox mode, compliance cron, subscription management console
   - Model: Sonnet 4.6
   - Read `specs/BuildPrompts/build-prompts-part-3.md` (BP16 section) before starting
   - Branch: feature/bp16-tenant-onboarding off dev

## Blocked on user

- **Apply pending migrations to atc-main before live traffic:**
  - BP15 new: `20260525000000_money_columns.sql`
  - BP14 new: `20260524060000_host_adapters.sql`, `20260524070000_tenant_host_configs.sql`
  - BP13 new: contacts/relationships/pipeline/quotes/host-booking-fee-configs migrations
  - BP12 new: customer_memories, anonymous_sessions_transfer migrations
  - BP11 new: 5 supervisor/kill-switch migrations
  - Still pending from BP09/BP10: tenant_source_revision, pending_rag_sync, tenant_persona_overrides, tenant_ai_mode
  - Command: `SUPABASE_DB_URL=<atc-main pooler URL> pnpm db:migrate`
- **Apply pending RAG migrations** (carry-over from BP09):
  - atc-rag: `0007_tenant_registry_shadow.sql`, `0008_retrieval_function_and_schema_fixes.sql`
- **Add ANTHROPIC_API_KEY to Vercel env vars for atc-main** (Haiku screening + supervisor + memory extraction + reconciliation upload)
- **Slur deny-list**: populate before opening to tenants
- **Avatar images**: generate using prompts in `specs/Agent Backstories Photo Guide v2.docx`
- **Redis (REDIS_URL)** — provision Upstash; add to Vercel env vars for atc-rag and `.env.local`
- **Vercel env vars to add** (atc-rag): `OPENAI_API_KEY`, `SUPABASE_RAG_ANON_KEY`
- **APP_ENCRYPTION_KEY_CURRENT**: generate + store in Vercel + offsite backup (BP14)
- **STRIPE_PRICE_*** env vars: add all 16 to Vercel (BP15)
- `STRIPE_TEST_SECRET_KEY` repo secret — carry-over from D-023
- `PLATFORM_DOMAIN_REGEX` Vercel env var for atc-main — carry-over from BP04

## Open questions

- sub_host_subcontractors revenue dashboard integration: the settings page exists but booking view doesn't yet subtract subcontractor share from revenue display (deferred to chat/dashboard work)
- `commissions.status` enum vs TEXT: BP01 may have created a postgres ENUM type; BP15 migration uses TEXT. Check when applying migrations
- Five supervisor preflight checks are stubs (D-046)
- Slur deny-list empty at launch (D-046)
- Audit log → real INSERT when §26 lands (D-036)
