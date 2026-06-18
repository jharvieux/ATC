# Session state — last updated 2026-06-17 13:30 UTC

## Just completed

- All 131 migrations applied to new staging/test Supabase DB via `db:reset`
- PR #1203 merge conflict resolved (MEMORY.md + SESSION.md rebase conflict)

## In flight

PR #1203 — feature/894-vercel-cron-migration — rebase in progress, needs push after conflict resolution.

## Next step

1. Push rebased PR #1203, wait for CI, then merge
2. Wire new Supabase project credentials into GitHub secrets:
   - Repo-level: `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY`, `SUPABASE_TEST_SERVICE_KEY`, `SUPABASE_TEST_DB_URL` (session-mode pooler URL, port 5432)
   - `staging` environment: `DB_URL` (new DB direct URL), `PROD_DB_URL` (prod direct URL)
   - Repo variable: `STAGING_PIPELINE_ENABLED=true`
3. Close issues #533 and #386 once secrets are set
4. `workflow_dispatch` nightly-full-test.yml to validate

## Blocked on user

- Provide from Supabase dashboard (Project Settings → API + Database):
  - Project URL → `SUPABASE_TEST_URL`
  - Anon key → `SUPABASE_TEST_ANON_KEY`
  - Service role key → `SUPABASE_TEST_SERVICE_KEY`
  - Session-mode pooler URL (Settings → Database → Connection string, Mode: Session, port 5432) → `SUPABASE_TEST_DB_URL`
- CRON_SECRET still needs to be set in Vercel dashboard manually

## Open questions

- check:duplication fails at 5.97% (threshold 5%) — pre-existing on dev, not caused by #1203. Should threshold be raised?
- Is this one DB serving both test/CI and staging pipeline roles, or will a second DB be created for staging?
