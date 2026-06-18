# Session state — last updated 2026-06-18 16:20 UTC

## Just completed
- **PR #1236** (auth E2E redirect test) — merged to dev
- **PR #1237** (booking lifecycle tests #1214) — merged to dev
- **PR #1238** (#1215 commissions + pricing mutation coverage) — merged to dev
  - commissionable-line-items.test.ts (18 tests, was 0%)
  - pricing-cache.test.ts (17 tests, was 3%)
  - line-routing.test.ts (+39 outputMapper tests, was 23%)
  - 73 total new tests; both audit agents clean
- **PR #1239** (#1218 RAG Stryker config) — opened, audit agents running

## In flight
- PR #1239 — Stryker RAG config (stryker.rag.config.json + pnpm mutate:rag) — awaiting audit comments + CI

## Next step
1. Wait for PR #1239 CI + audit agents → update PR body → merge
2. Then: #1233 — ConversationRailDrawer unit tests (low priority)
3. Opus queue (#1127, #1190, #1217) — deferred

## Blocked on user
- #563 — set `APP_STAGING_URL` secret in GitHub (ops action)
- #1222 — set `PLATFORM_DEFAULT_TENANT_ID` in Vercel Preview env scope (ops action)

## Open questions
- #1235 — GoTrue browser session fixture infrastructure (25 remaining E2E fixmes from #709)
- Opus queue (#1127, #1190, #1217) — deferred
- #1233 — ConversationRailDrawer unit tests — low-priority
