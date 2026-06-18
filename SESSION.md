# Session state — last updated 2026-06-18 16:50 UTC

## Just completed
- **PR #1240** (#1233 ConversationRailDrawer tests) — merged to dev (17 tests: retry mechanic + isStaff gate)
- **PR #1241** (#1227 stripe event_id RPC threading) — opened, both audit agents clean (d091 + pre-pr), CI running
  - migration 20260704000002: DROP old (TEXT, BIGINT), CREATE OR REPLACE (TEXT, BIGINT, TEXT) with stripe_event_id in both INSERT notes
  - webhook-handler.ts: pass event.id as p_stripe_event_id
  - stripe-webhook.error.test.ts: capture rpc args + assert event_id forwarded
- **Issue #1160** (column-reader guard) — closed; already implemented by check-column-readers.ts + pnpm check:column-readers

## In flight
- **PR #1241** (#1227) — CI running; audit-section-check queued after PR body edit; when green, merge with `gh pr merge 1241 --squash --delete-branch`

## Next step
1. Merge PR #1241 once all CI checks pass
2. Commit untracked `apps/main/.gitignore` (`.vercel` line, auto-created by Vercel CLI) directly on dev post-merge — trivial, no PR needed
3. Opus queue (#1127, #1190, #1217) — next priority; requires /model claude-opus-4-8

## Blocked on user
- #563 — set `APP_STAGING_URL` secret in GitHub (ops action)
- #1222 — set `PLATFORM_DEFAULT_TENANT_ID` in Vercel Preview env scope (ops action)
- #1127 — ledger unwind for transfer.reversed: spec §14.9 leaves post-payout money movement unspecified; needs spec owner input before implementing

## Open questions
- #1235 — GoTrue browser session fixture infrastructure (25 remaining E2E fixmes from #709)
- #890 — concierge from-address inbound handling; product decision (reply-to sufficient vs. full inbound routing)
- Opus queue (#1127, #1190, #1217) — deferred (require /model claude-opus-4-8)
