# Session state — last updated 2026-05-22 21:00 UTC

## Just completed

- BP17 — Termination, chunk-license survival, versioned consent, CCPA (§15.14 + §17): PR #58 merged to dev
  - Schema: legal_documents, legal_consents (4-policy RLS), user_consent_pending, termination columns on tenants, users.deleted_at, user_data_export_requests; RAG-side post_termination columns on knowledge_chunks
  - Termination flow: POST /api/admin/tenants/:id/terminate, Inngest side-effects handler, 90-day scoped chunk purge cron
  - RAG service: 4 new admin endpoints (post-termination-mark, purge-tenant-scoped-chunks, post-termination-queue, post-termination-review)
  - Versioned consent: consent API + pending API, /consent page, admin legal-docs publish page, /legal/ai-disclaimer
  - Post-termination chunk review queue: admin UI (retain/demote/hard-delete)
  - CCPA: export-request (1/30d rate limit), delete-request + undo-delete, user-data-export-build Inngest job, user-data-purge-after-grace stub, ccpa-staging-propagation-monitor cron
  - docs/runbooks/ccpa-staging-cleanup.md
  - 16 new unit tests; 249 total, 0 regressions
  - MEMORY.md D-050 added

## In flight

- Nothing in flight — clean checkpoint

## Next step

Begin BP18 — White-label: visual brand, custom domains, email-from, persona addendums, attribution (§16)
- Model: **Opus 4.7** (`/model claude-opus-4-7`) — SWITCH BEFORE CODING
- Branch: feature/bp18-white-label (create off dev)
- Read specs/BuildPrompts/build-prompts-part-4.md BP18 section before starting
- After BP18: switch back to Sonnet 4.6

## Blocked on user

- **Apply pending migrations to atc-main before live traffic:**
  - BP17 new: `20260527000000_legal_consent.sql`, `20260527000001_termination.sql`
  - BP16 new: `20260526000000_onboarding.sql`
  - BP15 new: `20260525000000_money_columns.sql`
  - BP14 new: `20260524060000_host_adapters.sql`, `20260524070000_tenant_host_configs.sql`
  - BP13 new: contacts/relationships/pipeline/quotes/host-booking-fee-configs migrations
  - BP12 new: customer_memories, anonymous_sessions_transfer migrations
  - BP11 new: 5 supervisor/kill-switch migrations
  - Still pending from BP09/BP10: tenant_source_revision, pending_rag_sync, tenant_persona_overrides, tenant_ai_mode
  - Command: `SUPABASE_DB_URL=<atc-main pooler URL> pnpm db:migrate`
- **Apply pending RAG migrations** (cumulative):
  - atc-rag: `0007_tenant_registry_shadow.sql`, `0008_retrieval_function_and_schema_fixes.sql`, `0009_post_termination.sql`
- **Add ANTHROPIC_API_KEY to Vercel env vars for atc-main**
- **Slur deny-list**: populate before opening to tenants
- **Avatar images**: generate using prompts in specs/Agent Backstories Photo Guide v2.docx
- **Redis (REDIS_URL)** — provision Upstash; add to Vercel env vars for atc-rag and .env.local
- **Vercel env vars to add** (atc-rag): OPENAI_API_KEY, SUPABASE_RAG_ANON_KEY
- **APP_ENCRYPTION_KEY_CURRENT**: generate + store in Vercel + offsite backup (BP14)
- **STRIPE_PRICE_*** env vars: add all 16 to Vercel (BP15)
- STRIPE_TEST_SECRET_KEY repo secret — carry-over from D-023
- PLATFORM_DOMAIN_REGEX Vercel env var for atc-main — carry-over from BP04
- **host_agency_legal_name**: update platform_settings before opening to tenants
- **ICA chunk-license-survival + legal-attribution wording**: attorney sign-off required (D-049, D-050)
- **USPS address validator**: vendor decision needed for Phase 2 (D-049)
- **Supabase Storage bucket 'user-exports'**: create in Supabase dashboard for CCPA export (BP17 TODO)
- **TODO(notifications) for CCPA export email**: wire Resend once email infra lands (BP18+)
- **Consent gate middleware**: requires @supabase/ssr install for cookie-based auth redirect (D-050, TODO bp18-auth)

## Open questions

- sub_host_subcontractors revenue dashboard integration deferred
- commissions.status ENUM vs TEXT: check when applying BP15 migration
- Five supervisor preflight checks are stubs (D-046)
- Audit log → real INSERT when §26 lands (D-036)
- pending_billing_period_change_effective_at application cron: not yet built (BP16 TODO)
- purgeUserDataPerRetention stub: full compliance purge deferred to Part 6 §25 (D-050)
