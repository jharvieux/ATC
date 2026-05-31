# Session state — last updated 2026-05-31 16:35 UTC

## Just completed
- Implemented signup/complete tenant provisioning route (issue #441) — full route + 21 tests
- Addressed all audit findings:
  - bindContactOnIdentification result now captured; warn on failure
  - Dead mock branch removed from test
  - Allowlist comment expanded to acknowledge two-layer isolation exception
  - Code comment nit (leading "INSERT users row —" fragment) removed
  - RLS snapshot updated with 3 missing weather_usage_metrics policies (BP23 drift)
- PR #523 open; both audit agents re-running on HEAD ba5694f (stale comments after nit commits)

## In flight
- PR #523 (feature/signup-complete-441): awaiting fresh audit agent comments + CI rerun
  - Head commit: ba5694f
  - All 21 tests pass, pnpm verify clean, D-091 approved, pre-PR approved
  - RLS snapshot fix included in this branch (weather_usage_metrics policies)

## Next step
- When audit agents post fresh comments on ba5694f: update PR body Audit section, merge when CI green
- After merge: close issue #441, check for any new issues to work on

## Blocked on user
- #518: ANON_COOKIE_SECRET provisioning in Vercel + Supabase Edge (blocks §24.x full deploy + #514)
- #519: RAG migrations 0020+0021 manual apply
- #473: GitHub secrets (STRIPE_TEST_SECRET_KEY, ANTHROPIC_API_KEY_TEST)
- #386: DB harness (blocks Cross-Tenant Probe real implementation)
- #500: CruiseMapper ingest (operator-blocked)
- #430: All ops checklist items (Vercel env, Stripe, Apify, PLATFORM_PEPPER)
- #441: signup UI (no frontend caller for the now-implemented route)
- #521: first-time login + promote to platform admin (needs-human-fix)

## Open questions
- Issue #514: remove unsigned-cookie legacy path — deferred until ANON_COOKIE_SECRET deployed + 1-2 week rollover
- Issue #455 (personas FK): stays open; actual FK migration needed once personas table exists
- Issue #423: search_host_inventory + generate_quote still stubs
- Issue #384 item 1: Cross-Tenant Probe — blocked on #386 (DB harness)
- Task #96: #475 contract test wrappers — depends on #473 GitHub secrets (user-blocked)
- D-091 race condition on signup/complete: two concurrent calls with different slugs could both pass the
  idempotency guard and create two tenant rows. Low probability on signup; UNIQUE(auth_user_id) rejected
  as too restrictive (would break legitimate multi-tenant users). Needs a DB-level atomic provision
  function (RPC) as follow-up if race becomes a real concern.
- D-091 warning on attribution binding failure: no retry path for failed CRM contact creation.
  Deferred — decide whether to add attribution_bound: boolean to response or move to Inngest.
- RLS snapshot delete policy gap: weather_usage_metrics_no_user_delete policy appears in migration
  but not in test DB (migration was applied before delete was added). Not causing CI failures.
