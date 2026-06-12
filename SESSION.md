# Session state — last updated 2026-06-12 14:35 UTC

## Standing rule (operator, permanent)
**No prod DB changes or manual prod deploys without per-instance operator approval.** Dev-merge pipeline stays autonomous.
**Note (D-205):** there is currently ONE Supabase project (mfaknjyqiwcjojukcnea) serving production — MCP applies ARE prod applies. Gate accordingly until #386/#534 split environments.

## Just completed
- Closed stale issues #1029 and #1030 (fixed by PR #1032 but not auto-closed)
- Filed #1034 (deferred-processing-guard fail-open) and #1035 (anonymous-limit, load-deny-list, customer-limit fail-open) based on codebase scan
- Implemented PR #1036: fail-closed DB error handling in 4 enforcement gates (#1034, #1035)
- Squash-merged PR #1036 to dev
- MEMORY.md entry D-217 added

## In flight
- Nothing in flight — clean checkpoint

## Next step
- Ship SESSION/MEMORY chore commit via PR, then look at remaining open issues (#1010 vendor-health split-brain, #1002 per-page role gates, #996 member-picker)

## Blocked on user
- Nothing

## Open questions
- `customer-limit.ts` `upsertCounter` existence check error path has no dedicated test (pre-pr NIT, write path, low blast radius — acceptable to leave unless the user wants it added)
- Pre-existing bare `{ data }` reads in `loadPlatformSetting` (persona prompt) and `generateHardLimitSummary` (best-effort summary) — intentionally out of scope per #1035
