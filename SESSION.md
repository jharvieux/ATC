# Session state — last updated 2026-06-18 17:05 UTC

## Just completed
- **PR #1240** (#1233 ConversationRailDrawer tests) — merged; 21 tests (retry mechanic + isStaff gate)
- **PR #1241** (#1227 stripe event_id RPC threading) — merged; migration 20260704000002 + webhook-handler.ts + test
- **Issue #1160** (column-reader guard) — closed; already implemented
- **Issue #1219** (mutation testing meta-tracker) — closed; all sub-issues resolved except #1217 (Opus)
- **PR #1242** (chore: MEMORY D-262 + apps/main/.gitignore) — CI running, no audit needed (doc-only)

## In flight
- **PR #1242** — CI running; when green, merge with `gh pr merge 1242 --squash --delete-branch`

## Next step
1. Merge PR #1242 once CI passes
2. Opus queue (#1127, #1190, #1217) — next priority; requires /model claude-opus-4-8

## Blocked on user
- #563 — set `APP_STAGING_URL` secret in GitHub (ops action)
- #1222 — set `PLATFORM_DEFAULT_TENANT_ID` in Vercel Preview env scope (ops action)
- #1127 — ledger unwind for transfer.reversed: spec §14.9 leaves post-payout money movement unspecified; needs spec owner input

## Open questions
- #1235 — GoTrue browser session fixture infrastructure (25 remaining E2E fixmes from #709); blocked on #563
- #890 — concierge from-address inbound handling; product decision (reply-to sufficient vs. full inbound routing)
- Opus queue (#1127, #1190, #1217) — deferred (require /model claude-opus-4-8)
