# Session state — last updated 2026-06-14 21:30 UTC

## Just completed
- **#1054 shipped + closed** via PR #1058 (squash `50588a98` on dev). Audited all of `TENANT_SCOPED_TABLES` against the live schema: 5 of 83 entries had no `tenant_id` column. Moved `invitations`, `rag_global_promotions`, `auth_attempts`, `security_incidents`, `staging_cron_skips` to `PLATFORM_READABLE_TABLES`. `attribution_rollup` (matview) correctly stays scoped (has tenant_id).
- **Reintroduction guard**: `scripts/check-tenant-scoped-columns.ts` — DB-backed, bidirectional (scoped-without-tenant_id FAILs; platform-readable-WITH-tenant_id FAILs unless allowlisted, one entry `email_log`). Wired into `.github/workflows/e2e.yml` after RLS coverage; CI ran it green (Playwright job passed). Added 5 regression tests in `tenant-client.test.ts`.
- Both audit agents clean on re-run (after a fix-commit adding an isolation comment at members/route.ts:89). All PR checks green incl. `pr-audit-section-check`. MEMORY D-224 added.
- **Filed 3 co-located bugs** (not fixed — surgical-changes): #1056 (invitations `status`→`rsvp_state` drift, 500s group-detail + broadcast; broadcast needs §18.6 product call), #1057 (abuse-recompute non-existent `tenant_id` on rag_global_promotions, swallowed → corrupts tenant_rag_quotas), #1059 (forum post-message reads invitations with wrong key + no group scope).

## In flight
- Nothing in flight — clean checkpoint. On `dev`, up to date with origin.

## Next step
- None forced. When resuming: run session-start auto-triage. Candidate work is the 3 issues filed this session (#1056 needs a §18.6 product decision from the user before broadcast recipient logic can land).

## Blocked on user
- **#1056** — needs a §18.6 product decision: which `rsvp_state` values (`pending`/`interested`/`not_going`/`booked`) count as broadcast/member recipients. Can't finalize the broadcast fix without it.
- beta053 production deploy approval (user's call, GitHub Actions run 27508043350).
- Staging re-test of the signup → legal-accept flow end-to-end (after deploy).
- Stashed `docs/site-urls.md` domain-change — still stashed, blocked on user.

## Open questions
- **#1052 still OPEN** — gated prod apply pending: migrate to test+prod via #534 → `pnpm rls:snapshot` + commit snapshots → re-run advisor → close.
- #1057 / #1059 — both unowned bug issues; #1057 (RAG quota corruption) is the higher-severity of the two.
- #1044 (remainingCount swallow in flush.ts), #1003 (D-201 vs D-170 role-scope) — still user's call.
