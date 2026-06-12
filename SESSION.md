# Session state — last updated 2026-06-12 16:05 UTC

## Standing rule (operator, permanent)
**No prod DB changes or manual prod deploys without per-instance operator approval.** Dev-merge pipeline stays autonomous.
**Note (D-205):** there is currently ONE Supabase project (mfaknjyqiwcjojukcnea) serving production — MCP applies ARE prod applies. Gate accordingly until #386/#534 split environments.

## Just completed
- PR #1041 merged: Anthropic added to vendor-health probe via GET /v1/models, closing #1010 (split-brain). MEMORY entry D-220 added.
- Closed #1035 manually (fixed by merged PR #1036; "Fixes issues #X and #Y" phrasing broke GitHub's auto-close keyword).
- Auto-triage: no open PRs; no nightly-failure/regression issues.

## In flight
- Nothing in flight — clean checkpoint

## Next step
- Remaining actionable open issues: #1025 (audit the 69 baselined service-role-tenant hits), #1003 (D-201 vs D-170 role-scope alignment review — user's call whether to act).

## Blocked on user
- Nothing

## Open questions
- D-220 operational note: dev IS the GitHub default branch, so "Fixes #N" auto-close works on dev merges — but multi-issue phrasing must be "Fixes #X, fixes #Y" (one keyword per issue ref).
