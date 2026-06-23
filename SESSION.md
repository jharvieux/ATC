# Session state — last updated 2026-06-23 11:40 CT

## Just completed
- **#1349** (D-290, PR #1351): decoupled prod migration-apply from the disabled staging pipeline + `docs/runbooks/prod-migration-apply.md`.
- **#1330 / #1353** (D-291, PRs #1354 + #1355): root-caused prod PDF import failures = pdf-parse/pdfjs-dist crashing on native `@napi-rs/canvas` in Vercel serverless (NOT image-only — my first diagnosis was wrong; user caught it). Swapped pdf-parse → **unpdf** (serverless-safe) via shared `lib/pdf/extract-pdf-text.ts` across both call sites (document import + RAG ingest); fixed the import reject route to allow `parse_failed` rows; deleted Lisa's 2 stuck imports from prod.
- **Pricing prod seed** (D-292): seeded prod `stripe_price_map` with all 16 rows from the gitignored `apps/main/stripe-sandbox-price-ids.env`. **Prod Stripe is TEST-mode (sk_test)** — sandbox IDs are correct (verified active + livemode:false). Verified all 16 checkout keys resolve from the DB and all 16 IDs are active in the prod Stripe account. Unblocks the Phase 3 admin pricing screen + the Phase 4 prereq.

## In flight
- Doc PR for D-292 (MEMORY + SESSION) — opening now.

## Next step (when resumed)
- **The unpdf fix (#1353) + reject fix (#1354) still need a prod deploy** to take effect (merged to dev, gated behind the prod release). Once deployed, Lisa re-uploads her PDF and it imports.
- **Phase 4 (#1340):** prod is now seeded — Phase 4 can proceed once its code is deployed (removes the STRIPE_PRICE_* env constants; the DB is now the source).
- Re-run the prod release when ready: drift gate (D-289) + migration-apply (D-290) both fixed; pricing table seeded (D-292).
- Other follow-ups: **#1346** (client TIER_CODE dup).

## Blocked on user
- **Operator setting:** confirm the `production` GitHub environment has **required reviewers** (D-290's approval gate).
- Prod release re-run + Phase 4 deploy are operator steps.

## Open questions / notes
- Re-seeding prod pricing: source is `apps/main/stripe-sandbox-price-ids.env` (gitignored). `vercel env pull` returns blanks for ALL vars in this environment — don't trust it for value inspection (D-292).
- Import pipeline still conflates `no_text_available` (parser-threw vs genuinely-empty) — minor, noted in #1353.
