# Session state — last updated 2026-05-21 TZ

## Just completed

- BP01: pnpm monorepo scaffold (PR #22 merged to dev)
  - apps/main: Next.js 14, Tailwind, shadcn/ui (button/card), /api/health, Zod env schema
  - apps/rag: Next.js 14, /api/health, Zod env schema
  - packages/config, packages/shared-types created
  - .github/workflows/ci.yml: new pnpm CI (lint/typecheck/build on Node 24)
  - deploy.yml updated from npm+Node20 to pnpm+Node24
  - All GitHub CI checks pass; Vercel check fails (projects not yet created)

## In flight

- Nothing in flight — clean checkpoint

## Next step

1. **User action required:** Create two Vercel projects pointing at this repo:
   - `main-app` → root directory: `apps/main`
   - `rag-service` → root directory: `apps/rag`
   Add `PLATFORM_PRIMARY_DOMAIN=ai-travelconcierge.com` as an env var in both projects.
   Then add `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` (main-app) as GitHub secrets.

2. **Next build prompt:** BP02 — Database foundations (tenants, users, RLS helpers, migration gate)
   - Requires: Two Supabase projects exist and connection strings are available
   - Model: claude-opus-4-7 (switch back to Sonnet at end)

## Blocked on user

- Vercel project creation (main-app + rag-service) — needed before Vercel CI check passes
- Supabase: Two separate projects needed (main-app and rag-service) before BP02 can run
- STRIPE_TEST_SECRET_KEY repo secret — still needed for contracts-canary nightly re-record (carry-over)

## Open questions

- Vercel check will remain red until user creates the projects and wires up VERCEL_PROJECT_ID secret
- deploy.yml still references singular VERCEL_PROJECT_ID — will need separate IDs for main-app vs rag-service when both deploy; flag this before BP07 Vercel deploy work
- All prior open questions from last session remain (email_connections schema, CODEOWNERS backup reviewer, rollback runbook screenshots, §12 eval harness deferral)
