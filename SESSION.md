# Session state — last updated 2026-05-21

## Just completed

- BP04 — Tenant resolution middleware landed (PR #31, squash-merged to `dev`)
  - `src/lib/tenancy/resolve-tenant.ts`: `getTenantBySlug` + `getTenantByCustomDomain` with 60s in-memory cache; service-role client (lint allowlisted)
  - `src/middleware.ts`: host-based routing — platform domain → sentinel, subdomain → slug lookup, custom domain → custom-domain lookup, no match → 404
  - `factories.ts`: `tenantContextFromRequest` now throws on `x-resolved-tenant-id = 'platform'`
  - `env.ts`: `PLATFORM_DOMAIN_REGEX` added (required)
  - Two migrations applied: `custom_domain` column on `tenants` (D-037), explicit `service_role` grants (D-039)
  - `service-role-client.ts`: now sets `global.headers.Authorization` explicitly (D-037)
  - Lint rule updated from basename to path-suffix matching; `resolve-tenant.ts` added to allowlist
  - `vitest.config.ts`: `@/` alias wired so tests can import via `@/lib/...` (D-038)
  - 27 tests pass (10 new middleware integration tests)
  - MEMORY.md D-037, D-038, D-039 logged

## In flight

- Nothing in flight — clean checkpoint. On `dev`, up to date with origin.

## Next step

1. **Next build prompt:** BP05 — Core domain schema (conversations, messages, bookings, commissions, subcontractors, payout_balances, payout_records, stripe_webhook_events)
   - Model: `claude-sonnet-4-6` (already on Sonnet — no switch needed)
   - Read `specs/BuildPrompts/build-prompts-parts-1-and-2.md` BP05 section before starting
   - Prerequisites: BP02–BP04 committed ✓; migration lint gate active ✓
   - Note: `contacts` FK on `conversations` deferred — use bare UUID column + `TODO(contacts-fk)` comment

## Blocked on user

- `STRIPE_TEST_SECRET_KEY` repo secret — still needed for contracts-canary nightly re-record (carry-over from D-023)
- **Manual follow-up from BP04:** Add `PLATFORM_DOMAIN_REGEX` to Vercel environment variables for `atc-main` (preview + production). Value: `^([a-z0-9-]+)\.ai-travelconcierge\.com$`

## Open questions

- `audit_log` table stub (D-036): swap `writeAuditRow` in `platform-admin-client.ts` to real INSERT when §26 lands; also swap `correlation_id` to ULID at same time (D-035)
- `tenantClient` Proxy: `.rpc()` and other patterns not yet intercepted (D-034). Extend when first used
- Migration lint gate does not enforce "every tenant-scoped table must have GRANTs for `authenticated` AND `service_role`" (D-032, D-039). Worth adding when next round of migration tooling lands
- `deploy.yml` singular `VERCEL_PROJECT_ID` (atc-main only) — split deferred to BP07 (D-030)
- RLS snapshot scope: §30.8 coverage for SECURITY DEFINER bodies + GRANT/REVOKE EXECUTE deferred (D-033)
- `.env.example` uses `RAG_SUPABASE_*` naming while `.env.local` uses `SUPABASE_RAG_*` — reconcile in BP05/BP06
- All prior open questions: `email_connections` schema, CODEOWNERS backup reviewer, rollback runbook screenshots, §12 eval harness deferral
