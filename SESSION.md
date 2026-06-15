# Session state — last updated 2026-06-15 15:30 UTC

## Just completed
- PR #1109 merged: fix `tier_not_found` on plan selection screen
  - Dual bug: wrong column name (`slug` → `code`) + missing type prefix (`agency` → `byo_agency`/`sub_agency`)
  - Added `TIER_CODE` map, reads `tenant_type`, switched to `tenantClient`, `safeAwaitRowCount` for CAS update
- Cut `release/0.4.4` from dev HEAD, pushed — pipeline running

## In flight
Nothing in flight — clean checkpoint

## Next step
Verify `release/0.4.4` pipeline completed (prod deploy + tag). Check GitHub Actions for the release workflow status.

## Blocked on user
Nothing

## Open questions
- Issue #1110: unit tests for `/api/onboarding/tier` route — deferred follow-up, not blocking
- Pre-existing: `webhook-handler-branches.test.ts` has no test for `tenant_type: null` (legacy rows) falling through to `connect_setup`. Safe behavior, low priority.
- Post-merge smoke test from #1104: `/api/tenant/billing`, `/api/commissions`, `/api/user/data` worth a manual check that fresh logins can reach those routes.
