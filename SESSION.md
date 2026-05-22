# Session state — last updated 2026-05-22 22:00 UTC

## Just completed

- BP18 — White-label: visual brand, custom domains, persona addendums, attribution (§16): branch ready for PR
  - Schema: `tenant_branding`, custom-domain state-machine columns on `tenants`, `persona_addendums` (4-policy RLS, persona_slug not persona_id)
  - Env vars: VERCEL_API_TOKEN, VERCEL_PROJECT_ID, PLATFORM_PARENT_DOMAIN, PLATFORM_ENV, DNS_RESOLVER_URL, RESERVED_PARENT_DOMAIN, PERSONA_ADDENDUM_HAIKU_MODEL
  - Reserved-parent-domain guard (3 layers): boot guard in env.ts; `assertProductionEnvForCrownJewel` in vercel/domain-client.ts; annual cron `crown-jewel-annual-audit`
  - Custom domain APIs: initiate + verify (DoH lookup of CNAME and TXT, Vercel API binding only after both checks pass)
  - 6 Inngest jobs: custom-domain-reverify (Sun 03:00), custom-domain-txt-grace-sweep (hourly), 4× lifecycle-cleanup (suspended/terminated/downgraded/tenant-removed), crown-jewel-annual-audit (Jan 1), persona-addendum-screen (event), persona-addendum-rescreen-nightly (04:00)
  - Persona addendum: Haiku screening prompt, screen + nightly re-screen, system-prompt builder updated with §16.6 explicit wrapping (literal BEGIN/END sentinels)
  - Email-from patterns A and B via send-tenant-email.ts (decrypts tenant Resend key via existing credential-cipher)
  - BrandedLayout email template (raw <head>/<img> per email-client requirements)
  - PoweredBy + LegalPageAttribution components with tier-gating (forced TRUE for byo_research/byo_professional/sub_starter)
  - WCAG AA color contrast helper
  - 27 new unit tests (contrast, addendum wrapping, crown-jewel guard, powered-by tier rules); 276 total, 0 regressions
  - docs/runbooks/crown-jewel-annual-audit.md
  - MEMORY.md D-051 added

## In flight

- BP18 branch ready: feature/bp18-white-label (uncommitted)

## Next step

1. Commit, push, open PR for BP18
2. After CI passes, merge to dev
3. After BP18: switch back to Sonnet (`/model claude-sonnet-4-6`)
4. Begin BP19 — OAuth signup + group bookings (§17 + §18) — already Sonnet

## Blocked on user

- **Apply pending migrations to atc-main before live traffic:**
  - BP18 new: `20260528000000_white_label.sql`
  - BP17 new: `20260527000000_legal_consent.sql`, `20260527000001_termination.sql`
  - BP16 new: `20260526000000_onboarding.sql`
  - BP15 new: `20260525000000_money_columns.sql`
  - BP14 new: `20260524060000_host_adapters.sql`, `20260524070000_tenant_host_configs.sql`
  - BP13 new: contacts/relationships/pipeline/quotes/host-booking-fee-configs migrations
  - BP12 new: customer_memories, anonymous_sessions_transfer migrations
  - BP11 new: 5 supervisor/kill-switch migrations
  - Still pending from BP09/BP10: tenant_source_revision, pending_rag_sync, tenant_persona_overrides, tenant_ai_mode
  - Command: `SUPABASE_DB_URL=<atc-main pooler URL> pnpm db:migrate`
- **Apply pending RAG migrations:**
  - atc-rag: `0007_tenant_registry_shadow.sql`, `0008_retrieval_function_and_schema_fixes.sql`, `0009_post_termination.sql`
- **BP18 env vars (Vercel atc-main):**
  - `VERCEL_API_TOKEN` (Vercel API token for domain binding)
  - `VERCEL_PROJECT_ID` (production project ID — atc-main prod)
  - `VERCEL_TEAM_ID` (if team-scoped)
  - `PLATFORM_PARENT_DOMAIN` = `tenants.ai-travelconcierge.com` (PRODUCTION ONLY)
  - `PLATFORM_ENV` = `production`/`staging`/`preview`
  - `DNS_RESOLVER_URL` (default Cloudflare DoH; override if needed)
  - **CRITICAL**: ensure `PLATFORM_PARENT_DOMAIN` is NOT set to the reserved value in staging/preview environments. Boot guard will refuse to start.
- **§16.3.4 Crown-jewel one-time setup**: bind `tenants.ai-travelconcierge.com` to the production atc-main Vercel project. Never bind it to any other project. See `docs/runbooks/crown-jewel-annual-audit.md`.
- **Add ANTHROPIC_API_KEY to Vercel env vars for atc-main** (used by persona addendum screening)
- **Slur deny-list**: populate before opening to tenants
- **Avatar images**: generate using prompts in `specs/Agent Backstories Photo Guide v2.docx`
- **Redis (REDIS_URL)** — provision Upstash; add to Vercel env vars for atc-rag and `.env.local`
- **Vercel env vars to add (atc-rag):** OPENAI_API_KEY, SUPABASE_RAG_ANON_KEY
- **APP_ENCRYPTION_KEY_CURRENT**: generate + store in Vercel + offsite backup (BP14)
- **STRIPE_PRICE_*** env vars: add all 16 to Vercel (BP15)
- STRIPE_TEST_SECRET_KEY repo secret — carry-over from D-023
- PLATFORM_DOMAIN_REGEX Vercel env var for atc-main — carry-over from BP04
- **host_agency_legal_name**: update platform_settings before opening to tenants
- **Attorney engagement** (now blocks THREE wordings — D-051):
  - §15.14.6 ICA chunk-license-survival clause
  - §17.6 AI Liability Disclaimer state-specific appendices
  - §16.7.1 legal-page attribution wording
- **USPS address validator**: vendor decision needed for Phase 2 (D-049)
- **Supabase Storage bucket `user-exports`**: create for CCPA export (BP17)
- **TODO(notifications)** wires for tenant emails (drift alerts, addendum suspension, CCPA export) — Resend integration pending

## Open questions

- sub_host_subcontractors revenue dashboard integration deferred
- commissions.status ENUM vs TEXT: check when applying BP15 migration
- Five supervisor preflight checks are stubs (D-046)
- Audit log → real INSERT when §26 lands (D-036)
- pending_billing_period_change_effective_at application cron: not yet built (BP16 TODO)
- purgeUserDataPerRetention stub: full compliance purge deferred to Part 6 §25 (D-050)
- BrandedLayout: React Email package not installed — current template returns JSX serializable via renderToStaticMarkup, but no email-send call site uses it yet (BP19+ will wire emails)
