# Session state — last updated 2026-06-22 22:40 CT

## Just completed
- Shipped: #1324+#1325 (PR #1333), #1314 (PR #1334), #1321 (closed, already done by #1322), specs PR #1331, D-284 docs PR #1335. Filed #1332.
- **Pricing-to-DB initiative — EPIC #1336 filed; Phase 1 SHIPPED (PR #1341 merged, closes #1332).** DB is now the single in-app source of truth for tier prices + seat ladder: migration (price columns + `pricing_seat_ladder`), cached `loadPricingTable` + `PRICING_FALLBACK`, injected-`PricingTable` pure compute fns, sentinel-safe seat-ladder walk, readers switched (abuse thresholds, public pricing-preview, dashboard plan card). Added `tierMonthlyPriceCents`. Both Opus audits clean.
- Logged **D-285** (incl. the prod-apply incident + lesson).

## ⚠️ Incident (resolved) — see D-285
- Applied the Phase-1 migration to **PROD** (`mfaknjyqiwcjojukcnea` = `.env.local` `SUPABASE_DB_URL`) instead of the test DB. Operator chose to leave the additive change in prod; migration made idempotent; correct test-DB apply done; snapshots match.
- **RULE: test-DB apply + snapshot regen uses `SUPABASE_TEST_DB_URL` (`deqpogiehyqpuxdetxzj`), NEVER `SUPABASE_DB_URL` (PROD). MCP applies are prod applies too.**

## In flight
- Nothing in flight — **paused at user request after PR #1341 merge.** This docs branch (`docs/session-d285`) carries the MEMORY D-285 + SESSION update; merge it then stop.

## Next step (when resumed)
- **Pricing Phase 2 (#1338)**: move the Stripe Price-ID mapping from env vars into a DB table (seeded from current env), switch `priceIdFor()` to read it. Then Phase 3 (#1339 admin screen + Stripe push), Phase 4 (#1340 remove constants).

## Blocked on user
- Prod deploy approval still outstanding from D-283 (document-import fix PR #1328 + Lisa's stuck import #1330).
- NOTE: the pricing columns/table are already live in the prod DB (from the incident) but the Phase-1 *code* is only on `dev`, not deployed to prod — consistent (new table unread by deployed code).

## Open questions
- Dashboard plan price shows the tier's headline period-aware monthly price, not the seat-inclusive all-in. Confirm when the admin screen lands (Phase 3).
