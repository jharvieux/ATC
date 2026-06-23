# Session state — last updated 2026-06-22 23:55 CT

## Just completed
- **Pricing EPIC #1336 Phase 2 SHIPPED** (PR #1343 merged, closes #1338). Stripe Price-IDs moved from the 16 `STRIPE_PRICE_*` env vars into a new `stripe_price_map` DB table:
  - Migration `20260708000000_stripe_price_map.sql` — no tenant_id, RLS-zero-policy, service-role-only grants (read + write for Phase 3). Not SQL-seeded (env secrets unreadable from a migration).
  - `loadPriceMap(db)` (cached, empty-uncached on error) + `priceIdFor(query, map)` (DB wins, env fallback, throw when neither). Checkout + billing routes inject the map.
  - `price-id-map.ts` — alias-free shared `PRICE_ID_ENV_MAP` (importable by scripts).
  - `scripts/seed-stripe-price-map.ts` — idempotent runtime backfill (`--target=test|prod`, dry-run default, `--apply`).
  - Tests `apps/main/test/unit/stripe/price-ids.test.ts`. Both Opus audits clean.
  - Fixed a pre-existing gap: `pricing_seat_ladder` (Phase 1) was missing from `rls-exceptions.sql`/`.txt` → rls-coverage red since Phase 1. Added both tables to both files.
- Migration applied to **TEST DB only** (`SUPABASE_TEST_DB_URL`); snapshots regenerated from it. Logged **D-286**.

## In flight
- Nothing in flight — clean checkpoint on `dev`. **Docs (D-286 MEMORY + this SESSION) still need to land via a `docs/*` PR.**

## Next step (when resumed)
- Land the docs PR (D-286 + SESSION) into `dev`.
- **Seed `stripe_price_map`** (operator step, env fallback covers everything until then — NOT urgent):
  - The `STRIPE_PRICE_*` values are NOT in local `.env.local` (0/16). Pull the right Vercel env first (e.g. `vercel env pull`), then `pnpm exec tsx scripts/seed-stripe-price-map.ts --target=test --apply`.
  - Prod seed is blocked until the migration reaches prod via the **release pipeline** (gated). Once the prod table exists, pull prod env + `--target=prod --apply` (user pre-approved running it in prod).
- **Pricing Phase 3 (#1339)**: platform-admin pricing screen + API that pushes edits to Stripe; should also populate/maintain `amount_cents` (live Stripe unit_amount) — noted on the issue. Opus-labeled.
- **Pricing Phase 4 (#1340)**: remove `TIER_BASE_PRICE_CENTS` / `SEAT_LADDER` code constants once DB is authoritative. Sonnet-labeled.

## Blocked on user
- Nothing blocking. (Prod seeding is pre-approved but gated on the prod migration landing via the release pipeline.)

## Open questions
- Are the `STRIPE_PRICE_*` price IDs actually configured in the deployed Vercel envs (staging/prod)? They're absent locally; checkout would already throw if they were unset in deploy, so presumably yes — confirm before the prod seed.
