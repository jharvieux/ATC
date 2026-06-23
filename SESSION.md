# Session state — last updated 2026-06-23 10:55 CT

## Just completed
- **#1349 done** (D-290, PR #1351 merged): decoupled prod migration-apply from the disabled staging pipeline. `deploy-production` now `needs` all CI gate jobs directly (+ deploy-staging as optional layer). Added `docs/runbooks/prod-migration-apply.md`.
- **#1330 / #1353 investigation + fixes** (D-291):
  - Root-caused the stuck PDF imports. My first "image-only PDF" diagnosis was WRONG (user caught it). Pulled Lisa's actual file from prod storage → pdf-parse extracts 8462 chars cleanly locally. Prod runtime logs: pdf-parse→pdfjs-dist tries to load native `@napi-rs/canvas` on Vercel, throws → `no_text_available`. Prod-wide bug: every uploaded-PDF import + RAG PDF ingest broken.
  - **PR #1354 merged**: import reject route now allows `parse_failed` rows (was pending_review-only), CAS-guarded.
  - **PR #1355 merged** (closes #1353): swapped pdf-parse → **unpdf** (serverless-safe, canvas-free) via shared `lib/pdf/extract-pdf-text.ts` (document-import + RAG paths; RAG OCR fallback kept); removed pdf-parse from serverExternalPackages + dep. `next build` clean.
  - Deleted Lisa's 2 stuck imports from prod (DB rows + storage files), operator-approved.

## In flight
- Nothing in flight — clean checkpoint on `dev`.

## Next step (when resumed)
- **The unpdf fix (#1353) and the reject fix (#1354) need a prod deploy to take effect** — both merged to dev, gated behind the prod release.
- **#1330 stays OPEN**: once the unpdf fix is in prod, Lisa re-uploads her confirmation PDF and it imports normally (file is fine; data: NCL Bliss/Alaska, conf QKXJV5F, cruise conf 61834126, Oct 3–10 2026, 5 pax, Haven Premier Owner's Suite).
- **Pricing prod seeding (operator):** run `scripts/seed-stripe-price-map.ts --target=prod --apply`, verify, then re-run the prod release (drift gate D-289 + migration-apply D-290 now both fixed).
- **Phase 4 (#1340):** gated on prod seeded + verified.
- Other follow-ups: **#1346** (client TIER_CODE dup).

## Blocked on user
- **Operator setting:** confirm the `production` GitHub environment has **required reviewers** (D-290's approval gate depends on it).
- Prod seeding + Phase 4 + prod release re-run are operator steps.

## Open questions
- Minor: import pipeline still conflates `no_text_available` (parser threw vs genuinely empty) — noted in #1353 as a small follow-up, not filed separately. OCR for genuinely-scanned PDFs remains a separate future need.
