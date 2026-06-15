# Session state — last updated 2026-06-15 14:15 UTC

## Just completed
- Merged PR #1104 (reauth timer fix for ICA stage) — prior session
- Cut and pushed `release/0.4.2` to trigger prod pipeline — prior session
- PR #1107: BYO vs sub-host onboarding split — merged to dev
  - state-machine ALLOWED_FORWARD_SKIPS (module scope), legal/route BYO branch, webhook BYO branch
  - byo/advance endpoint + page guards on ica/tax-form/connect pages
  - Full test coverage (375 files, 3,702 tests); two D-091 + pre-pr audit rounds; all checks green
  - MEMORY D-234 written

## In flight
Nothing in flight — clean checkpoint

## Next step
Verify `release/0.4.2` pipeline completed (prod deploy + tag). Check GitHub Actions for the release workflow status if needed.

## Blocked on user
Nothing

## Open questions
- pre-pr-reviewer flagged: `webhook-handler-branches.test.ts` has no test for `tenant_type: null` (legacy rows) falling through to `connect_setup`. Safe behavior (null !== "byo_host"), low priority follow-up.
- Post-merge smoke test from #1104: `/api/tenant/billing`, `/api/commissions`, `/api/user/data` gated by same broken `readAuthTime` — worth a manual check that fresh logins can reach those routes.
