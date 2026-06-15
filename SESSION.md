# Session state — last updated 2026-06-15 17:30 ET

## Just completed
- Added missing `tierErr` test to `subscription-checkout.test.ts`; merged PR #1111
- Merged PR #1112 (pricing single source of truth — SEAT_LADDER + TIER_BASE_PRICE_CENTS)
- Merged PR #1113 (billing route change_tier + switch_billing_period slug→code fix; fail-closed error guards)
- Opened issues #1114 (extract TIER_CODE/CODE_TO_TIER), #1115 (billing route unit tests)
- Diagnosed `internal_error` root cause: `FAR_FUTURE_TRIAL_END = 4102444800` (2099) exceeds Stripe's 730-day trial_end limit
- Opened PR #1116 — fix trial_end to `now + 729 days`; CI passing; awaiting merge
- Added MEMORY entries D-236, D-237, D-238, D-239

## In flight
- PR #1116 open, CI running — fix Stripe Checkout trial_end cap

## Next step
- Merge PR #1116 once CI is green
- Cut `release/0.4.5` (or `release/beta059`) to ship #1109, #1111, #1112, #1113, #1116 to production
- Push MEMORY.md + SESSION.md updates to dev via chore PR

## Blocked on user
- Release cut requires user to confirm readiness
- After #1116 merges and is deployed, user should test billing setup on staging/prod to confirm fix

## Open questions
- `apps/main/stripe-sandbox-price-ids.env` is untracked locally (not gitignored). Should be added to `.gitignore` if it's a dev artifact, or deleted if stale. User should confirm.
