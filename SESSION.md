# Session state — last updated 2026-06-14 23:30 UTC

## Just completed
- PR #1073 merged to dev: fix forum invitation gate (`fix/1059-forum-invitation-gate`). Two bugs: `invitee_email` was compared against UUID instead of email; no group_id scope on invitations query. Fixed by resolving email from `public.users` (tenant-scoped lookup) then querying invitations by `group_id + invitee_email`, excluding revoked tokens. D-091 audit + pre-pr audit clean. Issue #1059 closed.
- PR #1072 merged to dev: fix `rag_global_promotions` promoted-chunk count query (issue #1057). Was using non-existent `tenant_id` column; fixed with `!inner` join through `rag_submissions`. Issue #1057 closed.
- PR #1071 merged to dev: fix ICA scroll gate permanently disabling input when content fits without scrolling. Added `useEffect` mount check via `scrollContainerRef`. Issue tracked in #1074.
- PR #1070 merged to dev: fix deploy.yml auto-merge step crashing on "No commits between" (issue #1069). Now exits 0 on benign "already in sync" case.
- PR #1051 merged to dev: log D-222 (OAuth/beta053) + SESSION for the chore/log-beta053 carry-over. Conflict resolved: OAuth entry renumbered D-227 to avoid collision with dev's D-222 (RLS zero policies).
- Cut `release/beta056` tag on dev.

## In flight
- Nothing in flight — clean checkpoint.

## Next step
- User to direct. Remaining triaged bugs: #1044 (remainingCount swallow in flush.ts — P2, non-trivial), #1003 (D-201 vs D-170 role-scope alignment). Enhancement queue: #1061–#1065.

## Blocked on user
- beta053 production deploy approval (GitHub Actions run 27508043350) — may already have resolved.
- #1067 — dual migration-ledger drift; reconcile supabase-CLI ledger vs `scripts/db-migrate.ts` reader.
- #1003 — D-201 vs D-170 role-scope alignment decision.

## Open questions
- #1044 (remainingCount swallow in flush.ts) — non-trivial, awaits user prioritization.
- #1074 (test gap: no gate tests for forum RSVP + group scope) — tracking issue opened.
- #1050 — page-level login gate for onboarding deep links (deferred from beta053 work).
