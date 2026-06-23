# Session state — last updated 2026-06-23 06:30 CT

## Just completed
- Housekeeping (2026-06-23): closed stale **#1337** (Phase 1 done via PR #1341, never auto-closed); updated **EPIC #1336** checklist to mark Phases 1–3 DONE. Verified Phases 1–2 migrations are NOT yet in prod (see Blocked on user).
- **Pricing EPIC #1336 Phase 3 SHIPPED** (PR #1345 merged, closes #1339). Platform-admin pricing screen + push-to-Stripe API:
  - New admin area `pricing` (superadmin + finance) in `ADMIN_AREA_GRANTS`; `pricing_read`/`pricing_update` reasons; sidebar + hub-page nav.
  - `GET/PUT /api/admin/pricing`. PUT discriminated: `stripe_price` (create new Stripe Price → repoint product default → CAS-update `stripe_price_map` → update `tier_definitions` for base items; fail-closed on unseeded; idempotent; no-op skip) and `seat_ladder` (DB-only replace of `pricing_seat_ladder`, validated).
  - Orchestration in `lib/stripe/pricing-admin.ts` (Stripe + db injected, unit-tested). Screen at `(admin)/admin/pricing`.
  - Editing a base price populates the `amount_cents` Phase 2 left null.
  - `pnpm verify` green; both Opus audits clean. No migration (reuses Phase 1/2 tables). Logged **D-287**.
- Filed follow-up **#1346** (client `TIER_CODE` duplication — audit NIT, low priority).
- Posted Phase 4 gating checklist on **#1340**.

## In flight
- Nothing in flight — clean checkpoint on `dev`. **Docs (D-287 MEMORY + this SESSION) still need to land via a `docs/*` PR.**

## Next step (when resumed)
- Land the docs PR (D-287 + SESSION) into `dev`.
- **Pricing is functionally complete for dev** (Phases 1–3 merged). Remaining work is operational + the gated Phase 4:
  1. **Seed pricing in prod** (operator, pre-approved): once the `stripe_price_map` migration reaches prod via the release pipeline, run `scripts/seed-stripe-price-map.ts --target=prod --apply` with prod Vercel env pulled. Then verify live prod pricing sources the DB.
  2. **Phase 4 (#1340)** — remove `TIER_BASE_PRICE_CENTS`/`SEAT_LADDER` fallback constants. **Blocked** until the #1340 checklist passes (prod seeded + verified). Mechanical contract step.
  3. **#1346** (sonnet) — extract alias-free tier-code map for the pricing client.

## Blocked on user
- **Phase 4 (#1340) is hard-blocked on a PROD RELEASE.** Verified 2026-06-23 via supabase-main list_migrations: prod migrations end at `20260706000000`. Neither `20260707000000` (Phase 1 tier_pricing_columns) nor `20260708000000` (Phase 2 stripe_price_map) is in prod — the whole pricing DB foundation awaits a prod release. Prod still runs on the code-constant fallbacks, so Phase 4 (removing them) would break prod.
- Unblock order: (1) user cuts/approves a prod release → pipeline applies the two pricing migrations to prod; (2) seed prod (`scripts/seed-stripe-price-map.ts --target=prod --apply`, prod Vercel env pulled); (3) verify prod pricing reads the DB; (4) Phase 4 contract PR (quick, mechanical). I cannot initiate the release or apply prod migrations (release/* is user + pipeline only; D-285).

## Open questions
- Same as prior: confirm `STRIPE_PRICE_*` are configured in the deployed Vercel envs before the prod seed (they're absent locally). The Phase 3 screen will show a "STRIPE_SECRET_KEY not configured" banner and return 409 `price_not_seeded` on edits until `stripe_price_map` is seeded — expected.
