# RLS Snapshot Workflow

## What this is

`db/rls-snapshot-main.sql` is the committed baseline for all Row Level Security (RLS) policies on `public.*` plus `storage.objects`. `db/rls-snapshot-rag.sql` covers the RAG database's `public.*` relations. The `rls-snapshot-diff` CI job compares the live databases against these baselines on every PR and push to `release/*`, failing the build if they diverge.

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

A target whose env var is unset is **skipped with a warning**, not a failure. This means CI without the rag secret configured will still pass on main; once the secret is added, rag is checked automatically.

## Handling drift on dev

If someone ran a manual SQL change on dev that modified RLS (outside of a migration), the CI job will warn on dev pushes but not block. To resolve:

1. If the drift was intentional — create a migration that captures the change, regenerate the snapshot, commit both.
2. If the drift was accidental — revert the manual change in dev and regenerate the snapshot from the corrected state.

## Secrets required

The `rls-snapshot-diff` CI job requires:

- `SUPABASE_TEST_DB_URL` — direct Postgres URL for the main test/dev DB.
- `SUPABASE_RAG_TEST_DB_URL` — direct Postgres URL for the rag test/dev DB. (Optional; if absent the rag check is skipped.)

Add these at: GitHub → Settings → Secrets and variables → Actions → New repository secret.

Format: `postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres`
