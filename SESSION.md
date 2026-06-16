# Session state — last updated 2026-06-15 21:45 PT

## Just completed
- **Login 500 fix (#1135) merged to dev** (commit d3a2b86f). Root cause: reverse FKs
  `tenants_review_decided_by_user_id_fkey` + `tenants_termination_initiated_by_user_id_fkey`
  plus forward `users_tenant_id_fkey` = 3 users↔tenants relationships → ambiguous
  `tenants(...)` embed → PostgREST HTTP 300 → throw → 500 (ERROR 101242302, hit Lisa Travel).
  Fix: pin both embeds in `resolve-post-login.ts` to `tenants!users_tenant_id_fkey(...)`.
  Regression guard: `resolve-post-login-embed.test.ts`. Logged as MEMORY D-243.
- **Return-URL fix (#1133) merged to dev** (commit cd48be30). Onboarding Stripe redirect
  routes (subscription/checkout, connect/link, tax-form/stripe-link) now use
  `tenantOriginFromRequest(req)` not `platformBaseUrl()` — fixes #1132 ("Failed to load page"
  that stranded Lisa Travel on branding). Reverses D-241 §3. Logged as MEMORY D-244.
  Both audit agents clean (Sonnet, hash-bound). Added first-time-Connect-account branch
  test to tax-form-stripe-link.test.ts (D-094 coverage).
- Opened **#1136** (connect/link first-time-account branch test gap — deferred from #1133).
- Opened **#1137** (migration-history drift: 20260701000000_cruise_fk_expand +
  ...000002 absent from supabase-main applied history despite the columns being live;
  env not confirmed prod — needs verification before any action).

## In flight
- Nothing in flight — clean checkpoint. On `dev`, up to date with origin, working tree clean
  except untracked `apps/main/stripe-sandbox-price-ids.env` (do NOT stage — standing rule).

## Next step
- Await user's call on a PROD RELEASE. Both fixes (#1135 login, #1133 return-url) are in
  **dev only** — Lisa Travel's login 500 and onboarding stranding are STILL LIVE in prod.
  A single release should carry both. Standing rule: no prod deploy without per-instance
  operator approval. This is the user's decision.

## Blocked on user
- **Prod release decision** for #1135 + #1133 (see Next step). The dev-merge pipeline does
  NOT auto-deploy to prod ("Deploy to Production" is gated behind manual release approval).

## Open questions
- #1137 — which environment does the supabase-main MCP target (prod/staging/dev)? Need
  confirmation before reconciling the migration ledger or applying anything. Columns exist
  in that DB; ledger rows for 000000/000002 don't.
