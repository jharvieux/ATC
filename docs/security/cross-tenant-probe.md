# Cross-Tenant Probe Tests

## What this is

The cross-tenant probe enumerates every API route under `src/app/api/` and, for each HTTP method it exports, attempts to access a resource owned by tenant A while authenticated as tenant B. Any 2xx response is a cross-tenant data leak and fails the build immediately. Any 5xx is also a failure.

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

`tests/security/fixtures/cross-tenant-setup.ts` is currently a stub. Once the application schema exists, implement `setupCrossTenantFixtures()` to:

1. Create (or find) two orgs: `test-tenant-a` and `test-tenant-b`
2. Create one user per org
3. Sign in both users and capture their JWTs
4. Seed one resource of each type (booking, conversation, price_watch, quote, etc.) per org
5. Return the tokens and resource IDs keyed by resource type

Then set `CROSS_TENANT_FIXTURES=true` in CI to activate the live probe step.

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
