# Session state — last updated 2026-06-26 21:00 UTC

## Just completed
- **PR #1486 merged** (feature/sonnet-batch-1448-1470-1476-1485): four sonnet issues:
  - #1448: Buffer.byteLength fix in approve/tenant + approve/global
  - #1476: forum self-heal lazy-upsert on GET
  - #1485: merge duplicate SELECT policies (migration 20260713000000)
  - #1470: gated RAG integration test for segment-exact matching (ref, not closed)
- **Created #1487**: regenerate RLS snapshot after nightly applies migration 20260713000000

## In flight
- Nothing in flight — clean checkpoint

## Next step
1. After nightly-full-test runs (03:00 UTC) and applies migration 20260713000000 to TEST DB:
   - Checkout dev, run `pnpm rls:snapshot`, open doc-only PR for `db/rls-snapshot-main.sql`
   - See #1487 for full instructions
2. Main-app prod deploy (operator-owned) — makes all D-302/D-304/D-305 features live

## Blocked on user / operator
- **Main-app prod deploy (operator-owned):** makes live ALL of D-302/D-304/D-305 (chat indicator,
  invitee-token, forum auto-create, email-domain repoint, immediate invites, group delete) +
  D-300/D-301 chat changes + migration 20260712000000 (#1437) + PR #1480 email preview +
  PR #1486 fixes. Email + new group features + email-template preview do not work in the
  running app until this deploys.
- **Supabase advisor dismissals (#1481):** 26 false-positive advisors need manual dismissal
  in Supabase dashboard (both projects)
- **RAG nightly test wiring (#1470):** SUPABASE_RAG_DB_URL secret + RAG migration apply
  needed in nightly-full-test.yml for the new integration test to run
- **RLS snapshot regeneration (#1487):** run `pnpm rls:snapshot` + commit after nightly applies
  migration 20260713000000 to TEST DB

## Open questions
- Nothing new — prior questions unchanged
