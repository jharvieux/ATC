# Session state — last updated 2026-05-21

## Just completed

- BP03 — Data access layer landed (PR #28, squash-merged to `dev` as `511df7a`)
  - Three clients: `service-role-client.ts`, `tenant-client.ts` (Proxy auto-scopes `tenant_id` for filter + payload-injection operations), `platform-admin-client.ts` (`withPlatformAdminAudit` with `AsyncLocalStorage` nesting guard)
  - `TenantContext` provenance type + four factories (`tenantContextFromRequest` implemented; Stripe/Inngest/PlatformAdmin signature-only stubs)
  - Closed-enum `PLATFORM_ADMIN_REASONS` per §5.4.8 with `manual_emergency_intervention` reason_detail guard
  - Two custom ESLint rules wired into both flat config (`@atc/config`) and `next lint` legacy config via new `eslint-plugin-atc` workspace package
  - 11 unit tests pass (6 tenant-client, 5 audit wrapper)
  - Negative-lint verification done: forbidden import + unwrapped `platformAdmin*` function each trigger their rule
  - MEMORY.md entries D-034, D-035, D-036 logged for spec deviations and audit_log follow-up

## In flight

- Nothing in flight — clean checkpoint. On `dev`, up to date with origin.

## Next step

1. **Next build prompt:** BP04 — Tenant resolution middleware (`apps/main/src/middleware.ts` + `apps/main/src/lib/tenancy/resolve-tenant.ts`)
   - Model: `claude-sonnet-4-6` (already on Sonnet — no switch)
   - Read `specs/BuildPrompts/build-prompts-parts-1-and-2.md` BP04 section before starting
   - Watch for spec §29.2 Edge-vs-Node runtime decision; Supabase service-role client likely forces Node runtime — document in MEMORY.md if so
   - The BP04 prerequisite (the `x-resolved-tenant-id` header consumer in `tenantContextFromRequest`) is already in place from BP03

## Blocked on user

- `STRIPE_TEST_SECRET_KEY` repo secret — still needed for contracts-canary nightly re-record (carry-over from D-023)

## Open questions

- `audit_log` table is stubbed (D-036). When §26 lands the table, swap `writeAuditRow` body in `apps/main/src/lib/db/platform-admin-client.ts` to a real INSERT against a separate service-role client (not the wrapped function's `db`), and swap `correlation_id` from `crypto.randomUUID()` to a ULID generator at the same time (D-035)
- `tenantClient` Proxy currently intercepts `.from(table)` for select/update/delete/insert/upsert only. Per §5.4.7, `.rpc()` and other access patterns must be added when first used (D-034). Comment in `tenant-client.ts` flags this
- `deploy.yml` still references singular `VERCEL_PROJECT_ID` (atc-main only). Split into `VERCEL_PROJECT_ID_MAIN` / `VERCEL_PROJECT_ID_RAG` deferred to BP07 (D-030)
- `scripts/rls-snapshot.ts` scope: per D-033, current snapshot covers RLS-enabled state + policy bodies only. §30.8 also wants SECURITY DEFINER bodies/search_path + GRANT/REVOKE EXECUTE coverage. Static-time guard in `lint:migrations` is the line of defense for now; full §30.8 snapshot coverage is a follow-up
- Lint gate does NOT yet enforce "every tenant-scoped table must have explicit GRANTs for authenticated" (D-032). Worth adding when next round of migration tooling work lands
- The `.env.example` uses `RAG_SUPABASE_*` naming while `.env.local` uses `SUPABASE_RAG_*`. Reconcile when BP05 wires up the rag env schema
- All prior open questions still standing: `email_connections` schema, CODEOWNERS backup reviewer, rollback runbook screenshots, §12 eval harness deferral
