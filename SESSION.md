# Session state — last updated 2026-06-11 14:00 UTC

## Standing rule (operator, permanent)
**No prod DB changes or manual prod deploys without per-instance operator approval.** Dev-merge pipeline stays autonomous.
**Note (D-205):** there is currently ONE Supabase project (mfaknjyqiwcjojukcnea) serving production — MCP applies ARE prod applies. Gate accordingly until #386/#534 split environments.

## Just completed
- Merged PR #1001 (#811): platform admin role gates
  - `assertPlatformRole`, `getCachedAdminContext`, `assertPlatformRolePage` added to `assert-platform-admin.ts`
  - ~49 API routes migrated from `assertPlatformAdmin` to `assertPlatformRole` with per-route allowed-role arrays
  - `(admin)/layout.tsx` rewritten to use `getCachedAdminContext()`; `adminRole` threaded to `AdminShell`/`AdminSidebar`
  - Sidebar and hub page now filter by caller's role
  - 10 test files updated; 5 new auth unit tests
  - D-208 memory entry logged (D-170 scope used; D-201 narrowing deferred to #1003)
- Opened issue #1002: per-page `assertPlatformRolePage` gates for remaining ~22 admin pages
- Opened issue #1003: D-201 vs D-170 role-scope alignment review

## In flight
- Nothing in flight — clean checkpoint

## Next step
- Resume open issues per user direction: #826 (chat structured ship+date itinerary/price lookup), #885 (Playwright lightbox test), #953 Phase A (CruiseMapper cabin parser follow-up)
- PRs #993, #994, #995 (grants snapshot fixes) — waiting for CI, user said merge later

## Blocked on user
- Nothing

## Open questions
- #1003: D-201 narrowing — reviewer scope and mechanism review (user chose to defer)
- PRs #993/#994/#995 still open; user said "merge everything later"
