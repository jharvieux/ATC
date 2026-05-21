# Session state — last updated 2026-05-21 TZ

## Just completed

- BP02 — Database foundations landed (D-031, D-032, D-033)
  - 4 migrations applied to atc-main Supabase: tenancy/identity tables, RLS helper functions, RLS policies, explicit table grants
  - 4 RLS integration tests pass (cross-tenant denial, suspended-tenant write block, hard-delete trigger w/ and w/o override)
  - Migration lint gate (`pnpm lint:migrations`) wired into CI: enforces RLS coverage, SECURITY DEFINER conventions, no permissive policies
  - `db/rls-snapshot.sql` regenerated; `pnpm rls:check` passes
  - `tier_definitions` seeded with six tier codes
  - Vercel + Supabase secrets all configured (12 GitHub secrets total)
  - `SUPABASE_DB_URL` added to `.env.local` for main app

## In flight

- Nothing in flight — clean checkpoint. BP02 PR #26 merged to `dev`.

## Next step

1. **Next build prompt:** BP03 — Database access layer (TenantContext, three clients, audit wrapper)
   - Model: `claude-opus-4-7` (switch back to Sonnet at end)
   - Read `specs/BuildPrompts/build-prompts-parts-1-and-2.md` BP03 section before starting

## Blocked on user

- `STRIPE_TEST_SECRET_KEY` repo secret — still needed for contracts-canary nightly re-record (carry-over from D-023)

## Open questions

- `deploy.yml` still references singular `VERCEL_PROJECT_ID` (atc-main only). Split into `VERCEL_PROJECT_ID_MAIN` / `VERCEL_PROJECT_ID_RAG` deferred to BP07 (D-030)
- `scripts/rls-snapshot.ts` scope: per D-033, current snapshot covers RLS-enabled state + policy bodies only. §30.8 also wants SECURITY DEFINER bodies/search_path + GRANT/REVOKE EXECUTE coverage. Static-time guard in `lint:migrations` is the line of defense for now; full §30.8 snapshot coverage is a follow-up
- Lint gate does NOT yet enforce "every tenant-scoped table must have explicit GRANTs for authenticated" (D-032). Worth adding when next round of migration tooling work lands
- The `.env.example` uses `RAG_SUPABASE_*` naming while `.env.local` uses `SUPABASE_RAG_*`. Reconcile when BP05 wires up the rag env schema
- All prior open questions still standing: `email_connections` schema, CODEOWNERS backup reviewer, rollback runbook screenshots, §12 eval harness deferral
