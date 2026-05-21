# Session state — last updated 2026-05-21 TZ

## Just completed

- Vercel projects linked locally: `vercel link --cwd apps/main` and `apps/rag` → produced `.vercel/repo.json` with both project IDs (gitignored)
- GitHub secrets set: `VERCEL_TOKEN`, `VERCEL_ORG_ID` (`team_MIXzwKpnQSfuj3hd9ZyWVPPh`), `VERCEL_PROJECT_ID` (`atc-main`: `prj_UoveDAIzVqWYkDGLkLnAG2HM9V7L`)
- `PLATFORM_PRIMARY_DOMAIN=ai-travelconcierge.com` added in both Vercel projects (Production/Preview/Development)
- `.claude/` added to `.gitignore` (Claude Code local settings — not for the repo)
- MEMORY.md D-030 entry logged (singular VERCEL_PROJECT_ID; rag split deferred to BP07)

## In flight

- PR `chore/vercel-secrets-and-gitignore` → `dev`: commits MEMORY.md D-030, SESSION.md update, `.gitignore` `.claude/` entry. Doubles as the first test of the Vercel deploy secrets end-to-end.

## Next step

1. Merge `chore/vercel-secrets-and-gitignore` once CI (including Vercel deploy) goes green
2. **Next build prompt:** BP02 — Database foundations (tenants, users, RLS helpers, migration gate)
   - Model: `claude-opus-4-7` (switch back to Sonnet at end)
   - Prerequisite check: confirm whether `apps/rag` uses a separate Supabase project. If yes, capture `SUPABASE_RAG_TEST_URL`, `SUPABASE_RAG_TEST_ANON_KEY`, `SUPABASE_RAG_TEST_SERVICE_KEY`, `SUPABASE_RAG_TEST_DB_URL` as GitHub secrets before BP02

## Blocked on user

- `STRIPE_TEST_SECRET_KEY` repo secret — still needed for contracts-canary nightly re-record (carry-over from D-023)
- Rag Supabase secrets — only if the rag service uses a separate Supabase project (confirm before BP02)

## Open questions

- `deploy.yml` still references singular `VERCEL_PROJECT_ID`. Acceptable for now (only `atc-main` deploys). When BP07 adds rag deploy, split into `VERCEL_PROJECT_ID_MAIN` / `VERCEL_PROJECT_ID_RAG` (D-030)
- All prior open questions still standing: `email_connections` schema, CODEOWNERS backup reviewer, rollback runbook screenshots, §12 eval harness deferral
