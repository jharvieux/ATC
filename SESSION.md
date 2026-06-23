# Session state — last updated 2026-06-23 08:30 CT

## Just completed
- **Pricing EPIC #1336 Phases 1–3 shipped** (PRs #1341/#1343/#1345). Phase 4 (#1340) deferred until prod-verified.
- **Unblocked the prod release** (D-288): a `release/*` deploy failed the grants drift gate because prod lacked `stripe_price_map`. Diagnosed the D-285 ledger desync (Phase 1 applied to prod via raw psql → no ledger row; Phase 2 never applied). Applied both pending migrations to prod via `npx supabase db push --include-all` (ledger-correct, idempotent); grants/rls vs prod now clean.
- **Pipeline drift-gate fix** (D-289, PR #1350): the release gate compared PROD *before* the release's own migrations applied → false-failed every new-table release. Fix: grants:check now vs TEST DB on PR+release (mirrors RLS); removed the pre-migration prod gate; new nightly `prod-drift-check.yml` (read-only prod grants/RLS drift → deduped `prod-drift` issue), decoupled from releases + `STAGING_PIPELINE_ENABLED`.
- Filed **#1349** (no automated/approval-gated prod migration-apply path). Created `prod-drift` label.

## In flight
- **PR #1350** open. Just amended with: MEMORY D-288/D-289, MEMORY-INDEX, SESSION, and gitignoring `.claude/scheduled_tasks.lock` (+ `git rm --cached`). Needs: CI green → re-run both audit agents (diff changed) → squash-merge.

## Next step (when resumed)
- Get PR #1350 CI green, re-run d091 + pre-pr (Sonnet), squash-merge.
- **Pricing prod seeding (operator):** prod now has `stripe_price_map` (empty → env fallback still serves). Run `scripts/seed-stripe-price-map.ts --target=prod --apply` with prod Stripe Price IDs pulled from Vercel env, then verify live prod pricing reads the DB. Then the user can re-run the prod release (the drift gate will now pass).
- **Phase 4 (#1340):** still gated on prod seeded + verified.
- Follow-ups: **#1349** (prod migration-apply path), **#1346** (client TIER_CODE dup).

## Blocked on user
- Prod seeding + Phase 4 are operator steps (pre-approved in principle). The prod release itself is the user's to re-run once seeding is verified.

## Open questions
- Confirm `STRIPE_PRICE_*` are set in the deployed Vercel envs before the prod seed (absent locally). Until seeded, the Phase 3 admin screen returns 409 `price_not_seeded` on edits — expected.
