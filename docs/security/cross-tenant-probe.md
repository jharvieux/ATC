# Cross-Tenant Probe Tests

## What this is

The cross-tenant probe enumerates the deployed `/api/**` paths backed by every route under `src/app/api/` and exercises them while authenticated as tenant B. It first requires `/api/health` to return a readable main-app response with a concrete deployed commit, preventing an all-404 or wrong-host run from masquerading as acceptance.

For seeded dynamic route families, the request targets the matching tenant-A booking, conversation, or contact ID; any 2xx is a leak. Other dynamic routes use a non-existent sentinel, and collection/static-route 2xx JSON bodies are recursively inspected for every known tenant-A tenant, public-user, auth-user, booking, conversation, and contact identifier. A matching identifier is a leak, unreadable or non-JSON 2xx evidence fails closed, and 5xx responses fail. Expected 401/403/404 denials are intentional. Public routes such as `/api/health` must be explicitly documented in the allowlist.

The test runs on every PR as part of CI.

## How new routes are picked up

Automatically. The enumerator (`scripts/enumerate-api-routes.ts`) scans `src/app/api/**/route.{ts,js}` at test time and detects exported HTTP methods via static analysis. No manual registration needed.

When you add a new API route, the probe will test it on the next PR without any changes to the test file.

## How to handle a legitimate cross-tenant route

Some routes are intentionally cross-tenant — for example, a platform-admin API that can read any tenant's data. These must be explicitly allowlisted.

Add an entry to `tests/security/cross-tenant-allowlist.json`:

```json
{
  "route": "/api/admin/tenants",
  "method": "GET",
  "reason": "Platform-admin route. Requires platform-admin JWT role, not a tenant user JWT. Tenant users cannot obtain this token."
}
```

The `reason` field is required and must explain both why cross-tenant access is intentional and what prevents a regular tenant user from exploiting it.

## How to implement the fixture setup

`tests/security/fixtures/cross-tenant-setup.ts` creates deterministic, idempotent live fixtures. `setupCrossTenantFixtures()`:

1. Creates or reuses two active tenants and one confirmed user per tenant.
2. Signs in both users and returns real JWTs.
3. Seeds a contact, conversation, and booking for each tenant with deterministic IDs.
4. Returns route-family resource IDs plus the complete exact-identifier evidence set used to inspect otherwise legitimate 2xx responses.

`CROSS_TENANT_FIXTURES=true` activates the live probe. Human CI paths fail if the fixture credentials or application host are missing; Dependabot PRs use an explicit secret-less exemption that does not claim live acceptance.

## Running locally

```bash
# Enumeration-only mode (no credentials needed):
npm run test:cross-tenant

# Full probe with live fixtures:
NEXT_PUBLIC_SUPABASE_URL=https://xyz.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<key> \
CROSS_TENANT_FIXTURES=true \
npm run test:cross-tenant
```

The live probe binds its checked-out code and rebuilt main/RAG test-database
state to the event SHA. Unless the caller separately verifies `/api/health`'s
commit against that SHA, the shared `APP_BASE_URL` application revision remains
unverified and must be described that way.
