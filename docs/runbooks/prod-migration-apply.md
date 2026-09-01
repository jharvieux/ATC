# Production Migration Apply

How pending database migrations reach production, why the path is built the way
it is, and the **only** sanctioned manual fallback. Read this before applying any
migration to prod by hand.

## The standing rule

No prod migration or deploy happens without **per-instance operator approval**.
That approval is the `production` GitHub environment's required-reviewer gate —
every `deploy-production` run pauses there until a reviewer approves. There is no
autonomous prod-apply path, by design.

## How it works (the automated path)

Migrations are applied to prod by the `deploy-production` job in
`.github/workflows/deploy.yml`, as part of a `release/*` deploy:

1. Cut a release with the **Release** workflow (`release.yml`, `workflow_dispatch`
   → version `x.y.z`). It creates `release/x.y.z` from `dev` and pushes it.
2. The push triggers `deploy.yml`. All CI gates run (typecheck, lint, test,
   secret-scan, cve-scan, rls-snapshot-diff, cross-tenant-probe, contract-tests).
3. `deploy-production` waits on **all** of those gates directly (#1349). If any
   gate fails, prod is blocked. The staging path is an **optional** pre-prod
   layer gated by `STAGING_PIPELINE_ENABLED` (currently `false`, #533). When
   enabled, `db-copy` holds the non-cancelling `shared-test-db` lock continuously
   from production copy through staging migration, Vercel deployment, E2E, and
   the health check that proves the hosted commit equals the release SHA.
   `deploy-staging` is an always-run exact-SHA receipt: it preserves the required
   status name and fails when the holder fails, is cancelled, or reports stale
   provenance. When staging is off both jobs are skipped and do **not** block
   prod; when it is on and either fails, prod **is** blocked.
4. `deploy-production` reaches the `production` environment gate and **pauses for
   operator approval**.
5. On approval it runs, in order:
   - `npx supabase db push --include-all --db-url "$DB_URL"` — applies every
     pending migration **and records each in the `schema_migrations` ledger**.
   - `scripts/check-schema-drift.ts --target=main` — fails the deploy if the
     ledger diverges from what the DB actually reports (catches a silent push
     failure or an out-of-band dashboard change).
   - model-live check → Vercel prod deploy → smoke test → Inngest sync → tag →
     GitHub Release → auto-merge back to `dev`.

Because migration-apply happens *inside* the approved prod deploy, schema changes
ship with the code that needs them — one approval, one ledger-correct apply.

### Why deploy-production depends on the CI jobs directly

Before #1349, `deploy-production` listed only `deploy-staging` in `needs` and
relied on `always() && !failure()` to run when staging was skipped. Because
`failure()` evaluates the whole ancestor chain, a failing CI gate (e.g. the old
pre-migration grants-drift check, #1350) silently blocked prod — which is what
forced the manual psql apply behind the D-285 ledger desync. Depending on the CI
gates directly makes that blocking intentional instead of an emergent property of
a chain built for a feature that's turned off.

## Manual fallback — `supabase db push` ONLY, never raw psql

If you must apply a migration to prod outside a release (incident, hotfix), use
the Supabase CLI so the **ledger is recorded**:

```bash
# DB_URL = prod connection string. Pull it from the deployed Vercel env / the
# 'production' GitHub environment secret SUPABASE_PROD_DB_URL. Do NOT echo it.
cd apps/main
npx supabase db push --include-all --db-url "$DB_URL"

# Then confirm the ledger matches reality:
cd ../..
pnpm tsx scripts/check-schema-drift.ts --target=main --db-url "$DB_URL"
```

`supabase db push` is **idempotent** (already-applied migrations are skipped) and
writes a `schema_migrations` row for each migration it applies.

### NEVER apply prod migrations with raw `psql -f`

`psql -f some_migration.sql` against prod creates the objects but writes **no**
`schema_migrations` ledger row. The migration history then disagrees with the
live schema — exactly the **D-285** incident: Phase 1 pricing objects existed in
prod but were untracked, so the next release's drift gate could neither see them
nor reconcile them (D-288 had to repair the ledger by hand). Raw psql for
migrations is prohibited.

## Out-of-band drift detection

`prod-drift-check.yml` (nightly, read-only) diffs prod grants/RLS against the
committed baselines and opens a deduped `prod-drift` issue on divergence. It's
decoupled from releases and from `STAGING_PIPELINE_ENABLED`, so manual changes to
prod surface even when no release is in flight (D-289).

## Related

- `cancel-before-production.md` — reject at the prod approval gate.
- `rollback-database.md` — undo an applied migration.
- `nightly-test-db-migration.md` — how migrations are applied to the test DB.
- D-285 / D-288 / D-289 in `MEMORY.md`; issues #1349, #1350, #533.
