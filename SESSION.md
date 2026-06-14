# Session state — last updated 2026-06-14 22:10 UTC

## Just completed
- **#1052 — RLS enabled on 7 tables in LIVE BETA.** Applied `20260701000006_rls_enable_advisor_flagged_tables.sql` (merged to dev in #1053) directly to the beta DB via `psql --single-transaction` (user approved: "run it, its the live environment"). All 7 tables verified `relrowsecurity = t`. Security advisor now reports **zero** `rls_disabled_in_public`; the 7 show as INFO `rls_enabled_no_policy` (intended default-deny). Regenerated `db/rls-snapshot-main.sql` (rag unchanged). MEMORY D-226 added. PR `chore/1052-rls-snapshot-beta` → dev carries the snapshot + SESSION/MEMORY.
- **Discovered dual migration-ledger drift** → filed #1067. Beta runs on the supabase-CLI ledger (`supabase_migrations.schema_migrations`, current thru `20260701000005`); the custom runner `scripts/db-migrate.ts` reads a stale `public.schema_migrations` and collides if run against beta. `pnpm db:migrate` is the wrong tool for beta/prod.
- **#1056 wrap-up** (carried from prior session, now committed in this PR): MEMORY D-225 + SESSION reflect #1056 shipped via PR #1062 (`2006cacc`).

## In flight
- PR `chore/1052-rls-snapshot-beta` open to dev (snapshot + MEMORY D-225/D-226 + SESSION). Touches `db/rls-snapshot-main.sql` (.sql → audit agents required, not doc-only exempt). Awaiting audit agents + CI, then squash-merge + close #1052.

## Next step
- Run both audit agents on the PR, update `## Audit` block, wait for CI green, squash-merge, delete branch, then `gh issue close 1052` with the advisor-clean confirmation.

## UI / placeholder inventory (all filed, still open)
- #1061 coordinator broadcast composer UI · #1063 group forum UI · #1064 invitees roster UI · #1065 CRM relationship graph UI · #1066 stale-comment cleanup.

## Blocked on user
- beta053 production deploy approval (GitHub Actions run 27508043350).
- Staging re-test of signup → legal-accept flow end-to-end (after deploy).
- Stashed `docs/site-urls.md` domain-change — DELETED this session (stashes dropped per user OK); no longer blocked.

## Open questions
- **#1067** (new) — dual-ledger drift; reconcile source of truth + retire/guard `pnpm db:migrate` for beta/prod. Cross-refs #534 (disabled prod migration step in deploy.yml).
- **#1059** — forum post-message reads invitations with wrong key + no group scope (sibling of #1056).
- **#1057** — abuse-recompute non-existent `tenant_id` on rag_global_promotions → corrupts tenant_rag_quotas (higher severity).
- #1044 (remainingCount swallow in flush.ts), #1003 (D-201 vs D-170 role-scope) — still user's call.
