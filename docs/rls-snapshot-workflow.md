# RLS Snapshot Workflow

## What this is

`db/rls-snapshot-main.sql` is the committed baseline for all Row Level Security (RLS) policies on `public.*` plus `storage.objects`. `db/rls-snapshot-rag.sql` covers the RAG database's `public.*` relations. The `rls-snapshot-diff` CI job is the single uninterrupted main/RAG test-database provenance holder: it resets and applies both migration trees at the event SHA, compares both live databases with the committed baselines, and runs the database-backed main, RAG, ledger, and cross-tenant acceptance suites before releasing the shared lock.

This catches accidental RLS changes: a policy accidentally dropped or modified in dev won't silently reach production.

## When to regenerate

Regenerate after **any migration that adds, removes, or modifies an RLS policy** — or after enabling/disabling RLS on a table — in either database.

If you don't regenerate, the CI job will fail on that PR.

## Regeneration commands

Run against the dev/test Supabase instances (read-only queries — safe on any environment):

```bash
# Both databases at once (requires both env vars set)
pnpm rls:snapshot

# Or one at a time
SUPABASE_DB_URL="<main-connection-string>"     pnpm rls:snapshot:main
SUPABASE_RAG_DB_URL="<rag-connection-string>"  pnpm rls:snapshot:rag
```

Find connection strings in Supabase dashboard → Project Settings → Database → Connection string (URI).

Commit the updated snapshot(s) alongside the migration in the same PR:

```bash
git add db/rls-snapshot-main.sql apps/main/supabase/migrations/<new-migration>.sql
# or for rag
git add db/rls-snapshot-rag.sql apps/rag/supabase/migrations/<new-migration>.sql
git commit -m "migration: <description> (update RLS snapshot)"
```

## Checking for drift locally

```bash
pnpm rls:check              # both databases
pnpm rls:check:main         # main only
pnpm rls:check:rag          # rag only
```

A target whose env var is unset is **skipped with a warning** by these local commands. The primary CI holder has a stricter contract: human PRs, dev and release pushes, merge-group runs, and manual dispatches must establish live main, RAG, and cross-tenant modes before they can publish revision provenance. Dependabot PRs are the only explicit secret-less exemption, and their receipts state that no live acceptance is claimed.

## Handling drift on dev

If someone ran a manual SQL change on dev that modified RLS (outside of a migration), the CI job will warn on dev pushes but not block. To resolve:

1. If the drift was intentional — create a migration that captures the change, regenerate the snapshot, commit both.
2. If the drift was accidental — revert the manual change in dev and regenerate the snapshot from the corrected state.

## Secrets required

Live `rls-snapshot-diff` acceptance requires:

- `SUPABASE_TEST_DB_URL` — direct Postgres URL for the main test/dev DB.
- `SUPABASE_RAG_TEST_DB_URL` — direct Postgres URL for the rag test/dev DB.
- `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY`, and `SUPABASE_TEST_SERVICE_KEY` — main RLS live mode, fixture creation, and tenant-B authentication for the cross-tenant probe.
- `APP_STAGING_URL` — deployed application host exercised by the probe.

For non-release events, the exact event SHA binds the checked-out probe code and
both rebuilt test databases. `APP_STAGING_URL` is a shared deployed host, so its
application revision is explicitly reported as unverified; the receipt must not
claim that the host runs the event SHA. Release staging proves its hosted SHA
separately in the `db-copy` holder's health check.

Add these at: GitHub → Settings → Secrets and variables → Actions → New repository secret.

Format: `postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres`
