# Session state — last updated 2026-05-22 20:00 UTC

## Just completed

- BP16 — Tenant Onboarding & Compliance (§15): PR #56 merged to dev (all CI checks green, squash merge)
  - Migration: onboarding_stage CHECK, 8 new tenant columns, is_sandbox on conversations/bookings, tenant_inactivity_nudges + RLS, host_agency_legal_name platform_settings seed
  - lib/onboarding/state-machine.ts: strict forward-only progression, progressTo, revertTo, assertStageComplete
  - lib/timezones.ts: curated US timezone list
  - 12 onboarding API routes (profile, legal, ica, state-of-operation, tier, branding-skip, submit-review, subscription/checkout, tax-form/stripe-link, connect/link, slug-check, pricing/preview)
  - Admin review: GET /api/admin/tenants/review-queue + POST /api/admin/tenants/[id]/review (approve/reject/more-info)
  - GET/POST /api/tenant/sandbox + GET/POST /api/tenant/billing
  - Inngest compliance-nightly: inactivity nudges + 180d suspend; ICA check stub
  - Stripe webhooks: checkout.session.completed, account.updated
  - 11 onboarding pages + admin review queue UI + billing console page
  - 23 new unit tests (state machine: 12, seat pricing: 11); 233 total, 0 regressions
  - MEMORY.md D-049 added

## In flight

- BP17 branch: feature/bp17-termination-versioned-consent (just created off dev)

## Next step

1. Begin BP17 — Termination, chunk-license survival, versioned consent, CCPA export/delete (§15.14 + §17)
   - Model: **Opus 4.7** (`/model claude-opus-4-7`) — SWITCH BEFORE CODING
   - Read `specs/BuildPrompts/build-prompts-part-4.md` BP17 section before starting
   - Branch: feature/bp17-termination-versioned-consent (already created)
   - After BP17: switch back to Sonnet 4.6

## Blocked on user

- **Apply pending migrations to atc-main before live traffic:**
  - BP16 new: `20260526000000_onboarding.sql`
  - BP15 new: `20260525000000_money_columns.sql`
  - BP14 new: `20260524060000_host_adapters.sql`, `20260524070000_tenant_host_configs.sql`
  - BP13 new: contacts/relationships/pipeline/quotes/host-booking-fee-configs migrations
  - BP12 new: customer_memories, anonymous_sessions_transfer migrations
  - BP11 new: 5 supervisor/kill-switch migrations
  - Still pending from BP09/BP10: tenant_source_revision, pending_rag_sync, tenant_persona_overrides, tenant_ai_mode
  - Command: `SUPABASE_DB_URL=<atc-main pooler URL> pnpm db:migrate`
- **Apply pending RAG migrations** (carry-over from BP09):
  - atc-rag: `0007_tenant_registry_shadow.sql`, `0008_retrieval_function_and_schema_fixes.sql`
- **Add ANTHROPIC_API_KEY to Vercel env vars for atc-main**
- **Slur deny-list**: populate before opening to tenants
- **Avatar images**: generate using prompts in `specs/Agent Backstories Photo Guide v2.docx`
- **Redis (REDIS_URL)** — provision Upstash; add to Vercel env vars for atc-rag and `.env.local`
- **Vercel env vars to add** (atc-rag): `OPENAI_API_KEY`, `SUPABASE_RAG_ANON_KEY`
- **APP_ENCRYPTION_KEY_CURRENT**: generate + store in Vercel + offsite backup (BP14)
- **STRIPE_PRICE_*** env vars: add all 16 to Vercel (BP15)
- `STRIPE_TEST_SECRET_KEY` repo secret — carry-over from D-023
- `PLATFORM_DOMAIN_REGEX` Vercel env var for atc-main — carry-over from BP04
- **host_agency_legal_name**: update platform_settings value before opening to tenants (BP16, currently a TODO(operator) placeholder)
- **ICA chunk-license-survival + legal-attribution wording**: attorney sign-off required before Phase 2 (BP16 D-049)
- **USPS address validator**: vendor decision needed for Phase 2 (BP16 D-049)

## Open questions

- sub_host_subcontractors revenue dashboard integration: settings page exists but booking view doesn't subtract subcontractor share from revenue display (deferred)
- `commissions.status` enum vs TEXT: BP01 may have created a postgres ENUM; BP15 migration uses TEXT. Check when applying migrations
- Five supervisor preflight checks are stubs (D-046)
- Audit log → real INSERT when §26 lands (D-036)
- `pending_billing_period_change_effective_at` application cron: column + deferred flag exist but execution cron not yet built (BP16 Phase 1 TODO)
