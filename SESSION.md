# Session state — last updated 2026-05-31 12:30 UTC

## Just completed
- Cleaned up stale tasks (#37, #38, #66, #94, #95, #97, #98 all marked complete — issues already closed)
- Deleted duplicate port_info migration (issue #488 already closed in PR #508)
- Implemented signup/complete tenant provisioning route (issue #441)
- Addressed pre-PR + D-091 audit findings: fail-closed idempotency guard, partial-state coverage, tests (20/20)
- Added D-131 MEMORY.md entry for the assertPermission-can't-gate-pre-tenant-routes pattern

## In flight
- PR #523 (feature/signup-complete-441): second pass audit agents running; waiting for their results
  - Head commit: 92a2ab9 — all 20 tests pass, pnpm verify clean
  - D-091 warning remains: no UNIQUE(auth_user_id) constraint on users table to prevent signup/complete race
    (decided NOT to add — would block legitimate multi-tenant users; race is low-probability on sign-up)

## Next step
- When PR #523 second-pass audits complete: update PR body Audit section, merge when CI green
- Then: check if any new open issues, look at #514 (unsigned-cookie removal — deferred until ANON_COOKIE_SECRET deployed)

## Blocked on user
- #518: ANON_COOKIE_SECRET provisioning in Vercel + Supabase Edge (blocks §24.x full deploy + #514)
- #519: RAG migrations 0020+0021 manual apply
- #473: GitHub secrets (STRIPE_TEST_SECRET_KEY, ANTHROPIC_API_KEY_TEST)
- #386: DB harness (blocks Cross-Tenant Probe real implementation)
- #500: CruiseMapper ingest (operator-blocked)
- #430: All ops checklist items (Vercel env, Stripe, Apify, PLATFORM_PEPPER)
- #441: signup UI (no frontend caller for the now-implemented route)

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
