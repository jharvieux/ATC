# Session state — last updated 2026-06-20 23:30 UTC

## Just completed
- Merged PR #1317: redesigned the prod→staging DB-copy job (deploy.yml) to work on Supabase — public-only dump WITH ACLs, DROP SCHEMA reset + restore-without-clean, fail-closed error toleration (auth-FK + default-priv + schema-exists + non-zero-rc-no-output guard), parse-safe staging-fixups verification. Validated end-to-end against real prod+staging DBs (restore unexpected=0, grants:check no drift, fixups clean, row counts match prod). Opus d091 + pre-pr both clean.
- Earlier today: #1311 (RAG reconcile hardening, #1273), #1313 (PG17 client), #1305/#1306/#1308/#1310 (see prior). Set staging DB_URL secret to the test project. Deleted 2 orphan RAG shadow rows (#1312 closed).
- Logged D-281 (staging-refresh design + TEST-DB-==-staging-DB gotcha).

## In flight
- Nothing in flight — clean checkpoint (this SESSION/MEMORY update lands via a doc PR next).

## Blocked on user
- **Re-cut the release** (latest was release/0.7.3, which failed pre-fix). Delete the stale release branch, re-run the Release workflow. **Staging is now DISABLED** (`STAGING_PIPELINE_ENABLED` repo var set to `false` 2026-06-21 — no Vercel staging env yet), so db-copy + deploy-staging SKIP and prod deploys directly via deploy-production's `always() && !failure()` path → prod approval gate. Re-enable staging by flipping the var to `true` once a Vercel staging env is provisioned (the #1317 db-copy fix stays in place, dormant).

## Next step
- Doc PR for D-281 + this SESSION update. Then await the user's release re-cut.

## Open questions / follow-ups (issues filed)
- #1316 (opus): staging refresh doesn't restore Supabase-managed objects that depend on public (storage RLS policies, realtime publication membership); 2 auth-FK constraints unenforced on staging. Ops decision on whether/how to re-apply.
- #1314 (sonnet): tenant-registry-reconcile shadow UPDATE has no zero-row guard (pre-existing).
- #1309 (sonnet): tone-level<->label mapping test coverage.

## Notes
- SUPABASE_TEST_DB_URL (CI test DB for grants:check/RLS) IS the staging deploy DB. A local dry-run restoring prod into it breaks the CI grants check until prod's ACL grants are re-restored. (D-281)
- Prod Supabase main = Postgres 17.6; deploy.yml pins postgresql-client-17 (D-280).
- Release + dependabot-update-branch workflows use GH_PAT (D-279).
- Model: on Opus 4.8 (user's deliberate default this session).
