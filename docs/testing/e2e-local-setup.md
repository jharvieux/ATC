# E2E (Playwright) — local setup

Tier 1: smoke-test only. No DB, no auth, no RAG service required.

## One-time setup

```bash
# 1. Install the Chromium browser (~90MB)
pnpm exec playwright install chromium

# 2. Create apps/main/.env.local with shape-valid placeholder values.
#    Required by apps/main/instrumentation.ts boot-time Zod check.
#    The Tier-1 smoke test (/api/health) doesn't actually call any of these,
#    but boot fails without them.
cat > apps/main/.env.local <<'EOF'
PLATFORM_PRIMARY_DOMAIN=localhost
PLATFORM_DOMAIN_REGEX=^([a-z0-9-]+)\.localhost$
NEXT_PUBLIC_SUPABASE_URL=https://fake.supabase.local
NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-key-placeholder
SUPABASE_SERVICE_ROLE_KEY=service-role-placeholder
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
APP_ENCRYPTION_KEY_CURRENT=$(openssl rand -base64 32)
APP_ENCRYPTION_KEY_ID_CURRENT=app-v1
INVITATION_TOKEN_HMAC_KEY=invitation-hmac-placeholder
ANTHROPIC_API_KEY=sk-ant-placeholder
PLATFORM_PEPPER=platform-pepper-placeholder
FORENSICS_ENCRYPTION_KEY_CURRENT=$(openssl rand -base64 32)
FORENSICS_ENCRYPTION_KEY_ID_CURRENT=forensics-v1
OAUTH_MICROSOFT_ENABLED=false
EOF
```

`.env*.local` is gitignored — these placeholders never leave your machine.

## Run

```bash
# Auto-starts `next dev` for apps/main; runs the test; tears down.
pnpm exec playwright test tests/e2e/health.spec.ts

# Run all specs (most are test.skip skeletons today)
pnpm exec playwright test

# Open the HTML report after a run
pnpm exec playwright show-report
```

Set `BASE_URL=https://your-preview.vercel.app` to run against a deployed preview instead — the config's `webServer` block is suppressed when `BASE_URL` is set.

## What works today

- `tests/e2e/health.spec.ts` — real smoke against `/api/health`.

The other 11 specs in `tests/e2e/` are `test.skip` skeletons. Filling them in is "Tier 2" work — see follow-ups below.

## Tier 2 follow-ups (real UI flows)

1. **Test Supabase project** (separate from staging/prod) with migrations applied + fixtures seeded via `pnpm fixtures:load`.
2. **Auth bypass for tests** — either bake a long-lived test JWT into a fixture user, or add a `TEST_AUTH_BYPASS_TOKEN` shortcut behind `NODE_ENV==="test"`. The routes use `assertPermission()` which validates a Supabase Bearer JWT.
3. **AI mocking** — chat flows need real Anthropic keys OR a `MOCK_AI=true` env that returns canned responses.
4. **RAG service** — chat retrieves chunks, so `apps/rag` needs to run on `:3001` with its own Supabase project + seeded chunks. Add a second `webServer` entry.
5. **Convert one skeleton** — pick `tests/e2e/price-watch.spec.ts` (newest backend, stable contract) and walk it through Tier 2.

## Tier 3 follow-up (CI)

GitHub Actions workflow with Postgres service container + migrations + fixture seed + both servers + Playwright with sharding + artifact upload on failure.
