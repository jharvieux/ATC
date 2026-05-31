# Session state — last updated 2026-05-31 14:05 UTC

## Just completed
- Merged PR #511 (§23.10.1 quote estimate expiry sweep email, closes #452) — 5 audit rounds
- Merged PR #512 (§15.4/§15.5/§17.4 legal_consents writes + doc rendering, closes #422) — 3 audit rounds
- Opened PR #513 (§24.x anon session HMAC hardening, closes #442) — audit agents in background

## In flight
- PR #513 feature/anon-session-hmac — D-091 agent a7452450457fb3325 + pre-PR agent a85ba550c57b215d5 running

## Next step
- Wait for PR #513 audit agents; update body + merge when CI + audit check pass
- Next issue: assess #424 (booking flow Stages 2+3) or #423 (real persona tools)

## Blocked on user
- Issue #500: manually trigger CruiseMapper ingest jobs (operator action)
- Issue #473: provision STRIPE_TEST_SECRET_KEY + ANTHROPIC_API_KEY_TEST GitHub secrets
- Issues #455, #459, #460: blocked on #386 (DB harness migration)
- Issue #441: blocked on signup UI that calls /api/auth/signup/complete
- ANON_COOKIE_SECRET env var must be provisioned in Vercel + Supabase Edge before PR #513 is deployed
- RAG migrations 0020+0021 still need manual apply (from prior session)

## Open questions
- feature/auth-secure-cookies branch is obsolete (PR #443 squash-merged) — can be deleted
- docs/runbooks/auth-session-architecture-findings.md is untracked — decide whether to commit or discard
- vite-8 ignore (#330) may now be removable — dependency-ignore-watch will surface it
