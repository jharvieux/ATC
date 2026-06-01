# Session state — last updated 2026-06-01 01:20 UTC

## Just completed
- Merged PR #528: Apify utilization + editable budget in resource dashboard
  - 3-layer stacked area chart (AI/Email/Apify), cruise-line breakdown table, inline budget editor
  - GET adds apify_spend_ledger + apify_monthly_budget_usd queries; PUT extended for both fields
  - checkMonthlyBudget gains optional capUsdOverride; adapter reads DB cap before each guard check
  - 20 new unit tests, adapter mocks updated with maybeSingle()
  - Also fixed pre-existing weather avg_7d test broken at month-start
  - Also added CLAUDE.md rule: never ignore a bug — fix trivially or open an issue
- Opened #529: monthlySpendUsd() silently swallows DB errors (fail-open risk on ledger failure)
- Opened #530: dead ternary in runForLine() — timeout vs dispatch-failed never distinguished

## In flight
- Nothing in flight — clean checkpoint

## Next step
- Fix #529 (monthlySpendUsd fail-open on DB error) — non-trivial, opened as issue
- Fix #530 (dead ternary) — trivial cleanup

## Blocked on user
- #518: ANON_COOKIE_SECRET provisioning in Vercel + Supabase Edge (blocks §24.x full deploy + #514)
- #473: GitHub secrets (STRIPE_TEST_SECRET_KEY, ANTHROPIC_API_KEY_TEST)
- #386: DB harness (blocks Cross-Tenant Probe real implementation)
- #500: CruiseMapper ingest (operator-blocked)
- #430: All ops checklist items (Vercel env, Stripe, Apify, PLATFORM_PEPPER)
- #521: first-time login + promote to platform admin (needs-human-fix)

## Open questions
- Issue #514: remove unsigned-cookie legacy path — deferred until ANON_COOKIE_SECRET deployed + 1-2 week rollover
- Issue #455 (personas FK): stays open; actual FK migration needed once personas table exists
- Issue #384 item 1: Cross-Tenant Probe — blocked on #386 (DB harness)
- Post-signup cross-domain session: after signup/complete, user must re-authenticate on tenant subdomain — acceptable UX trade-off for now
- D-091 warning: attribution binding failure has no retry path — decide attribution_bound: boolean in response or move to Inngest
- Interactive paths in signup/complete have no test coverage at any layer; deferred until @testing-library/react + jsdom added or E2E stubs fleshed out
- GET /api/admin/resource-utilization handler-level integration test deferred (consistent with existing route testing strategy — pure helpers tested, no handler mock suite)
