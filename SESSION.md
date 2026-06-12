# Session state — last updated 2026-06-12 13:15 UTC

## Standing rule (operator, permanent)
**No prod DB changes or manual prod deploys without per-instance operator approval.** Dev-merge pipeline stays autonomous.
**Note (D-205):** there is currently ONE Supabase project (mfaknjyqiwcjojukcnea) serving production — MCP applies ARE prod applies. Gate accordingly until #386/#534 split environments.

## Just completed
- Implemented fixes for GitHub issues #1028, #1029, #1030 (D-091 second-layer tenant isolation for 17 service-role queries)
- Opened PR #1032 (feature/tenant-filter-hardening-1028-1029-1030 → dev)
- Fix-up commit (f26d141f): addressed d091 WARNING (test mocks not asserting tenant_id values) and shared NIT (rsvp route selecting unused tenant_id); moved d091-allow comment inline above .from()
- Both audit agents re-run and posted hash-bound marker comments; PR body updated
- All CI checks green; PR #1032 squash-merged and branch deleted
- MEMORY.md entry D-216 added

## In flight
- Nothing in flight — clean checkpoint

## Next step
- Open a follow-up GitHub issue for `deferred-processing-guard.ts` fail-open on DB read error (both `conversations` and `anonymous_sessions` SELECTs destructure only `{ data }`, ignoring `{ error }` → guard passes on DB timeout). Pre-existing on dev, surfaced by d091-reviewer on PR #1032.

## Blocked on user
- Nothing

## Open questions
- `deferred-processing-guard.ts` fail-open on DB error: pre-existing issue surfaced by audit but not in scope for PR #1032. Needs GitHub issue.
