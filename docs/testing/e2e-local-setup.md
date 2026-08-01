# E2E (Playwright) — local setup

Two tiers shipped: Tier 1 (smoke) and Tier 2 (real DB + auth bypass, no Docker). Tier 2.5 (PostgREST for Supabase JS client routes) and Tier 3 (CI) are follow-ups.

## Tier 1 — smoke test (no DB needed)

```bash
# One-time: install the Chromium browser (~90MB)
pnpm exec playwright install chromium

# Run the smoke
pnpm exec playwright test tests/e2e/health.spec.ts
# → 1 passed (2.2s)
```

A `.env.local` is required so `apps/main`'s boot-time Zod check passes — see "Env file" below. Junk shape-valid placeholders are fine for Tier 1; the smoke route doesn't call any of them.

`.env*.local` is gitignored.

## Tier 2 — real Postgres + auth bypass (no Docker)

What this gets you:
- Real Postgres 17 running locally via brew (~50MB RAM idle, ~150MB disk).
- All 65 migrations applied (52 main + 13 RAG, includes pgvector).
- Auth bypass so Playwright specs can hit `assertPermission`-gated routes without GoTrue.
- 3 real price-watch specs passing (`tests/e2e/price-watch.spec.ts`).

What it does NOT get you (yet — Tier 2.5):
- Routes that use `tenantClient().from(...)` to read/write DB. The Supabase JS client speaks PostgREST, not raw Postgres. Specs that need DB reads (price-watch create with real cache lookup, list, patch, rearm) stay `test.skip` until PostgREST runs locally.

### Setup

```bash
# 1. Install Postgres 17 + pgvector
brew install postgresql@17 pgvector
/opt/homebrew/opt/postgresql@17/bin/initdb -D /opt/homebrew/var/postgresql@17 -U "$USER" --auth=trust --encoding=UTF8
brew services start postgresql@17

# 2. Create test DBs + enable pgvector
PG=/opt/homebrew/opt/postgresql@17/bin
$PG/createdb -h localhost atc_main_test
$PG/createdb -h localhost atc_rag_test
$PG/psql -h localhost -d atc_rag_test -c "CREATE EXTENSION IF NOT EXISTS vector;"

# 3. Bootstrap the Supabase auth schema stub (both DBs)
$PG/psql -h localhost -d atc_main_test -f scripts/local-pg-bootstrap.sql
$PG/psql -h localhost -d atc_rag_test  -f scripts/local-pg-bootstrap.sql

# 4. Apply migrations to both
SUPABASE_DB_URL="postgresql://$USER@localhost:5432/atc_main_test" pnpm db:migrate
SUPABASE_DB_URL="postgresql://$USER@localhost:5432/atc_rag_test"  MIGRATIONS_DIR=apps/rag/supabase/migrations pnpm db:migrate

# 5. Seed the Tier-2 fixture user + tenant
SUPABASE_DB_URL="postgresql://$USER@localhost:5432/atc_main_test" pnpm tsx scripts/seed-tier2-test.ts
# Prints the TEST_AUTH_BYPASS_* values to add to your .env.local.

# 6. Run specs
pnpm exec playwright test tests/e2e/price-watch.spec.ts
# → 3 passed, 5 skipped (Tier 2.5)
```

### Env file

`apps/main/.env.local` (gitignored). Generate the two encryption keys with `openssl rand -base64 32`.

For the two Supabase JWTs, run the helper (signs them with the secret in `scripts/local-postgrest.conf`):

```bash
pnpm tsx scripts/print-test-jwts.ts >> apps/main/.env.local
```

Then add the rest of the env vars:

```env
PLATFORM_PRIMARY_DOMAIN=localhost
PLATFORM_DOMAIN_REGEX=^([a-z0-9-]+)\.localhost$
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
# NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY come from
# the `pnpm tsx scripts/print-test-jwts.ts` step above.
SUPABASE_DB_URL=postgresql://YOUR_USER@localhost:5432/atc_main_test
STRIPE_SECRET_KEY=sk_test_placeholder
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_placeholder
STRIPE_WEBHOOK_SECRET=whsec_placeholder
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_placeholder_connect
INNGEST_SIGNING_KEY=signkey-placeholder
INNGEST_EVENT_KEY=eventkey-placeholder
SERVICE_JWT_PRIVATE_KEY=service-jwt-private-placeholder
SERVICE_JWT_KEY_ID=v1
RAG_SERVICE_URL=http://localhost:3001
RAG_WEBHOOK_SECRET=rag-webhook-placeholder
MAIN_APP_ADMIN_API_KEY=admin-api-key-placeholder
APP_ENCRYPTION_KEY_CURRENT=<openssl rand -base64 32>
APP_ENCRYPTION_KEY_ID_CURRENT=app-v1
INVITATION_TOKEN_HMAC_KEY=invitation-hmac-placeholder
ANTHROPIC_API_KEY=sk-ant-placeholder
PLATFORM_PEPPER=platform-pepper-placeholder
FORENSICS_ENCRYPTION_KEY_CURRENT=<openssl rand -base64 32 — must differ from APP key>
FORENSICS_ENCRYPTION_KEY_ID_CURRENT=forensics-v1
OAUTH_MICROSOFT_ENABLED=false

# Tier-2 auth bypass — paste the IDs printed by scripts/seed-tier2-test.ts
TEST_AUTH_BYPASS_TOKEN=tier2-local-test-secret
TEST_AUTH_BYPASS_TENANT_ID=22222222-0000-0000-0000-0000000000a1
TEST_AUTH_BYPASS_USER_ID=a0000000-0000-0000-0000-0000000000a1
TEST_AUTH_BYPASS_PUBLIC_USER_ID=b0000000-0000-0000-0000-0000000000b1
```

### How the auth bypass works

Three locks, all required (any one missing → bypass refuses, real Supabase auth path runs):
1. `NODE_ENV !== "production"`
2. `TEST_AUTH_BYPASS_TOKEN` env var is set
3. Request's `Authorization: Bearer <token>` matches that value

When all three pass:
- `apps/main/src/middleware.ts` sets `x-resolved-tenant-id` from `TEST_AUTH_BYPASS_TENANT_ID` (skips the DB-backed `getTenantBySlug` / `getTenantByCustomDomain` lookups).
- `lib/db/factories.ts → tenantContextFromRequest` returns the synthetic context.
- `lib/auth/assert-permission.ts → assertPermission` returns a synthetic User with `id = TEST_AUTH_BYPASS_PUBLIC_USER_ID` and `status="active"` — no DB lookup. Production deploys MUST NOT set `TEST_AUTH_BYPASS_TOKEN` — Vercel env should leave it unset.

### What's running

- `postgres@16`/`@17` via `brew services` — autostart on login. Stop with `brew services stop postgresql@17`.
- Playwright's `webServer` starts/stops the Next.js dev server per test run.

### Reset

```bash
# Drop + recreate (you'll need to re-seed)
$PG/dropdb -h localhost atc_main_test && $PG/createdb -h localhost atc_main_test
$PG/dropdb -h localhost atc_rag_test  && $PG/createdb -h localhost atc_rag_test
# … then re-run steps 3, 4, 5 above.
```

## Tier 2.5 — PostgREST for DB-backed specs (live)

All 8 price-watch specs pass — the Supabase JS client (used by `tenantClient` and `createServiceRoleClient`) talks to PostgREST, which talks to local Postgres. No GoTrue, no Docker.

Three pieces:
1. **PostgREST** on port 54331 (config: `scripts/local-postgrest.conf`).
2. **Tiny path-rewriting proxy** on port 54321 (`scripts/local-supabase-proxy.ts`) — Supabase JS hits `${URL}/rest/v1/<table>`; PostgREST serves at `/<table>`. The proxy strips the prefix and forwards. It also returns 401 for `/auth/v1/*` so any code path that tries to call GoTrue surfaces loudly (the bypass should cover everything; a 401 here means a missing bypass site).
3. **Table grants** (`scripts/local-pg-grants.sql`) — `service_role` gets `BYPASSRLS` (matches Supabase Cloud); `anon` and `authenticated` get the standard CRUD grants with RLS still gating.

### Setup (one-time, after Tier 2 setup)

```bash
brew install postgrest

# Apply grants to atc_main_test
PG=/opt/homebrew/opt/postgresql@17/bin
$PG/psql -h localhost -d atc_main_test -f scripts/local-pg-grants.sql
```

The JWT secret + the anon/service-role JWTs are committed in `scripts/local-postgrest.conf` and the `.env.local` template (local-test values only — must never be used in production).

### Run

Playwright's `webServer` block auto-starts PostgREST, the proxy, and Next.js dev in the right order — just run:

```bash
pnpm exec playwright test
# → 9 passed, 29 skipped (most other specs still skeletons)
```

Manual mode (independent of Playwright):

```bash
postgrest scripts/local-postgrest.conf &
pnpm tsx scripts/local-supabase-proxy.ts &
pnpm --filter @atc/main dev
```

### Reset

PostgREST notices schema changes automatically. After dropping + re-applying migrations, also re-run the grants script:

```bash
$PG/psql -h localhost -d atc_main_test -f scripts/local-pg-grants.sql
```

### Alternative

`supabase start` (Docker) for full-fidelity local Supabase including GoTrue, PostgREST, and Storage. Heavier (~2GB RAM, Docker daemon required) but matches production exactly. Drop the bypass and use real fixture-user JWTs if going this route.

## Tier 3 — CI (later)

GitHub Actions workflow:
- Postgres service container with pgvector
- Run `local-pg-bootstrap.sql` + migrations + `seed-tier2-test.ts`
- Optionally `postgrest` as a second service container
- `pnpm exec playwright test` with `--shard 1/3` parallelism
- Upload `playwright-report/` + `test-results/` on failure
