# RLS Snapshot Workflow

## What this is

`db/rls-snapshot.sql` is a committed baseline of all Row Level Security (RLS) policies on the `public` schema. The `rls-snapshot-diff` CI job compares the live database against this baseline on every PR and push to `release/*`, failing the build if they diverge.

This catches accidental RLS changes: a policy accidentally dropped or modified in dev won't silently reach production.

## When to regenerate the snapshot

Regenerate after **any migration that adds, removes, or modifies an RLS policy**, or after enabling/disabling RLS on a table.

If you don't regenerate, the CI job will fail on that PR.

## Regeneration command

Run against the dev/test Supabase instance (read-only query — safe to run on any environment):

```bash
SUPABASE_DB_URL="<your-connection-string>" npm run rls:snapshot
```

Find the connection string in Supabase dashboard → Project Settings → Database → Connection string (URI).

Then commit the updated snapshot alongside the migration in the same PR:

```bash
git add db/rls-snapshot.sql supabase/migrations/<new-migration>.sql
git commit -m "migration: <description> (update RLS snapshot)"
```

## Handling drift on dev

If someone ran a manual SQL change on dev that modified RLS (outside of a migration), the CI job will warn on dev pushes but not block. To resolve:

1. If the drift was intentional — create a migration that captures the change, regenerate the snapshot, commit both.
2. If the drift was accidental — revert the manual change in dev and regenerate the snapshot from the corrected state.

## Handling a legitimate cross-schema policy

If a policy references another schema (e.g., `auth.users`), it will appear in the snapshot as-is. No special handling needed — just commit the snapshot after adding the migration.

## Secret required

The `rls-snapshot-diff` CI job requires `SUPABASE_TEST_DB_URL` (a direct Postgres connection URL for the test/dev Supabase instance). Add this at:

GitHub → Settings → Secrets and variables → Actions → New repository secret

Format: `postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres`
