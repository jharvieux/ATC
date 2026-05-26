# Supabase project setup — runbook

**Owner:** platform operator + new-environment owner
**Spec ref:** §29.5
**Companion:** [local-development.md](../local-development.md), [disaster-recovery.md](./disaster-recovery.md)

This runbook walks you through provisioning a fresh Supabase project for a new ATC environment (staging, load-test, a new region) end-to-end: organization setup, extensions, RLS bootstrap, service-role grants, storage buckets, and verification.

The production Supabase project was set up by hand in 2025. This document captures the steps so the next one (staging refresh, new region, disaster-recovery cutover) doesn't require archaeology.

## Prerequisites

- A Supabase organization. Use the existing platform organization for environments that share billing; create a new org only when you need separate billing.
- The migration role connection string for the new project (lands in `SUPABASE_DB_URL` for migration tooling).
- An IT-operator email separate from any individual's personal Supabase login. Bus-factor matters.
- A planned project name. Convention: `atc-<env>-<n>` where `<env>` is `prod`, `staging`, `loadtest`, `dr-failover`, etc.

## Sequence

### 1. Create the project

1. Supabase dashboard → **New project**.
2. Region: pick the same region as the parent Vercel project (today: `us-east-1`).
3. Database password: generate via `openssl rand -base64 32`, store in 1Password under `ATC / Supabase / <env-name> / db-password`.
4. Plan: **Pro** for any non-load-test environment. Free for ephemeral load-test environments only — Free tier lacks PITR (see [disaster-recovery.md](./disaster-recovery.md) §B).
5. Wait for provisioning (typically 2 minutes).

### 2. Enable extensions

In the SQL editor, run:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;        -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";     -- uuid_generate_v4() (legacy paths)
CREATE EXTENSION IF NOT EXISTS pg_trgm;         -- trigram search on contacts/quotes
CREATE EXTENSION IF NOT EXISTS pgvector;        -- RAG embeddings (rag schema)
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;  -- query performance debugging
```

Verify:

```sql
SELECT extname, extversion FROM pg_extension ORDER BY extname;
```

`pgvector` is required only for the RAG service Supabase project. The main app project can skip it.

### 3. Apply baseline migrations

From a checkout of this repo:

```sh
# Main app
cd apps/main
SUPABASE_DB_URL="postgres://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres" \
  pnpm dlx supabase db push

# RAG service (if this Supabase project is for the RAG side)
cd apps/rag
SUPABASE_DB_URL="postgres://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres" \
  pnpm dlx supabase db push
```

This applies every file under `supabase/migrations/` in order. Expect 50+ migrations on a green-field run.

### 4. RLS bootstrap

All tenant-scoped tables enable RLS as part of their migration. Verify with:

```sql
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname IN ('public', 'rag')
  AND tablename NOT LIKE 'pg_%'
ORDER BY schemaname, tablename;
```

Every row should show `rowsecurity = true`. If any row shows `false`, check the migration for that table; missing RLS is a launch-blocker. See [db/rls-snapshot-main.sql](../../db/rls-snapshot-main.sql) for the expected baseline; the `RLS Snapshot Diff` CI check protects this on every PR.

### 5. Service-role grants

Service-role bypasses RLS by design (§5.4.4). The role is auto-provisioned by Supabase as `service_role` and its key lives in the dashboard → **Settings → API → service_role secret**.

Copy the key into:
- 1Password: `ATC / Supabase / <env-name> / service-role-key`
- The deploying environment's secret store: Vercel → Project → Settings → Environment Variables → `SUPABASE_SERVICE_ROLE_KEY`

Never paste the service-role key into a `.env.local` checked into git. The `no-direct-service-role-import` lint rule prevents app code from importing the client outside an allowlisted set of files.

### 6. Public Anon + JWT secret

Same dashboard panel:
- **anon public** key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- **JWT Secret** (Settings → API → JWT Settings) → only if `SUPABASE_JWT_SECRET` is set (optional per §28.2; the platform relies on Supabase's built-in verification)

### 7. Storage buckets

The platform uses these buckets (created by code at runtime where possible, but worth pre-creating to avoid first-request latency):

| Bucket | Visibility | Used by |
|---|---|---|
| `quote-pdfs` | private | `/api/quotes/[id]/send` PDF render |
| `help-screenshots` | private | help-docs PDF/DOCX export, help-AI screenshot uploads |
| `import-uploads` | private | `/api/imports/manual` CSV/PDF uploads |
| `rag-tenant-media` | private | (reserved for §33.6 tenant-uploaded assets — not used today) |

Create from the dashboard or via `supabase storage`. Set bucket access to **private** unless explicitly listed otherwise.

### 8. Auth configuration

In the dashboard → **Authentication → Settings**:

- **Site URL**: the public app URL (`https://<env>.aitravelconcierge.com` for prod-like environments).
- **Redirect URLs**: every domain users sign in from. For multi-tenant subdomains, use a wildcard pattern (`https://*.aitravelconcierge.com`).
- **JWT expiry**: 3600 (1 hour) — matches the default. Raising it requires §26.6 monitoring updates.
- **Email auth**: enabled. Use Supabase's default email provider initially; swap to a custom SMTP when production-ready.

### 9. Sentry + observability

- Enable **Supabase Logs → Postgres logs** with at least 7-day retention (Pro tier default).
- Hook Logflare (Supabase's log drain) to a destination (Datadog / Honeycomb / a Supabase-side log bucket).
- Set up the §26.5a forensics retention purge cron to run; the cron is wired in code but worth verifying it's firing in Inngest dashboard.

### 10. PITR (Point-in-Time Recovery)

PITR is on by default on Pro tier with 7-day retention. Verify in the dashboard → **Database → Backups**. For environments that hold real user data, raise retention to 14 days per [disaster-recovery.md](./disaster-recovery.md).

### 11. First admin

Until at least one row exists in `platform_admins`, only the service-role bearer can hit `/api/admin/*`. Seed the first admin:

```sql
INSERT INTO platform_admins (auth_user_id, role, email)
VALUES (
  '<your-supabase-auth-user-uuid>',
  'superadmin',
  '<your-email>'
);
```

You can find your auth user UUID in the dashboard → **Authentication → Users** after signing in to the app once.

### 12. Verification

A complete setup passes these spot checks:

- `SELECT COUNT(*) FROM pg_extension` returns ≥ 4 (with pgvector if RAG)
- `SELECT COUNT(*) FROM pg_tables WHERE schemaname IN ('public', 'rag') AND rowsecurity = false` returns 0
- `SELECT COUNT(*) FROM platform_admins` returns ≥ 1
- `SELECT COUNT(*) FROM platform_settings WHERE key = 'last_staging_refresh_at'` is 0 on a fresh staging env (no refreshes yet)
- The app boots without `verifyEnvAtBoot()` throwing
- A test user can sign up and the resulting row appears in `auth.users` and (after onboarding) `public.users`
- The `RLS Snapshot Diff` CI check passes against the new environment's `pg_policies`

### 13. Hand-off

When the project is provisioned and verified:

1. Add the connection details to 1Password under `ATC / Supabase / <env-name>`.
2. Add the project to the CI/CD pipeline configuration if it's a stable environment (staging, production).
3. Document any environment-specific overrides in `docs/runbooks/environments.md` (or create it).
4. Update [disaster-recovery.md](./disaster-recovery.md) if this is a new primary or failover environment.

## Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| `verifyEnvAtBoot()` throws on `SUPABASE_SERVICE_ROLE_KEY` | Key wasn't copied to the Vercel env | Settings → API → service_role secret → copy into Vercel env vars |
| `relation "public.platform_admins" does not exist` | Migrations didn't apply | Re-run `supabase db push` with the right `SUPABASE_DB_URL` |
| RLS Snapshot Diff CI check fails on the new env | Some table missed enabling RLS | Inspect the failing diff against `db/rls-snapshot-main.sql`; manually `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and add the missing policy |
| pgvector extension missing on RAG | Extension wasn't enabled before migrations | Connect via SQL editor, run `CREATE EXTENSION pgvector;` then re-run failed migrations |
| First admin can't log in | The `auth_user_id` doesn't match the actual Supabase auth user | Sign in once via the app, then look up the real UUID in `auth.users` and INSERT |

## See also

- [`docs/local-development.md`](../local-development.md) — local-dev env-var checklist
- [`docs/env-audit.md`](../env-audit.md) — spec §28 vs code reconciliation
- [`docs/runbooks/disaster-recovery.md`](./disaster-recovery.md) — PITR + full-loss recovery procedures
- [`docs/runbooks/secret-rotation.md`](./secret-rotation.md) — periodic key rotation
- [`db/rls-snapshot-main.sql`](../../db/rls-snapshot-main.sql) — RLS policy baseline
- [`db/rls-snapshot-rag.sql`](../../db/rls-snapshot-rag.sql) — RAG-side RLS baseline
