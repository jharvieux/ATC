# Session state — last updated 2026-06-23 09:15 CT

## Just completed
- **#1349 done** (D-290, PR #1351 merged): decoupled prod migration-apply from the disabled staging pipeline. `deploy-production` in `deploy.yml` now `needs` all 8 CI gate jobs directly (+ `deploy-staging` as an optional pre-prod layer), instead of `needs: [deploy-staging]` alone. The apply logic was already ledger-correct (`supabase db push` + `check-schema-drift.ts`, behind the `production` env reviewer gate); only the dependency graph reaching it was broken (STAGING_PIPELINE_ENABLED=false skipped deploy-staging → prod-apply rode the transitive `failure()` chain → any failing CI gate silently blocked it = the D-285 manual-psql trigger). Now `failure()` blocks prod iff a gate truly failed.
- Added `docs/runbooks/prod-migration-apply.md` (automated flow + approval gate + supabase-db-push-only manual fallback, NEVER raw psql).
- Both audit agents clean (Sonnet). #1349 auto-closed on merge.

## In flight
- Nothing in flight — clean checkpoint on `dev`.

## Next step (when resumed)
- **Pricing prod seeding (operator):** prod now has `stripe_price_map` (empty → env fallback still serves). Run `scripts/seed-stripe-price-map.ts --target=prod --apply` with prod Stripe Price IDs pulled from Vercel env, then verify live prod pricing reads the DB. Then re-run the prod release — the drift gate (D-289) now passes AND the migration-apply path (D-290) is no longer fragile.
- **Phase 4 (#1340):** still gated on prod seeded + verified.
- Follow-ups: **#1346** (client TIER_CODE dup).

## Blocked on user
- **Operator setting:** confirm the `production` GitHub environment has **required reviewers** configured — D-290's approval-gating (and the no-prod-deploy-without-asking rule) depends on it. It's outside the repo.
- Prod seeding + Phase 4 + the prod release re-run are operator steps.

## Open questions
- Confirm `STRIPE_PRICE_*` are set in the deployed Vercel envs before the prod seed. Until seeded, the Phase 3 admin screen returns 409 `price_not_seeded` on edits — expected.
