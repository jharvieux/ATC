# MEMORY.md — AI Travel Concierge Decision Log

Newest entries on top.

---

## D-036 — 2026-05-21 — Audit-log writes stubbed to console.warn; switch to real INSERT in §26 work

**Decision:** `withPlatformAdminAudit` writes audit rows as structured `console.warn("[audit-log:STUB] {...json}")` lines. The `audit_log` table does not exist yet (created in spec §26). The audit-row shape mirrors what the table will accept, so the swap to a real INSERT is a one-line body change in `writeAuditRow`.

**Why:** The build prompt explicitly calls for this stub: "the audit_log table doesn't exist yet — write to a console.warn(...) with a structured JSON payload AND a TODO(audit-log) comment."

**Follow-up:** When §26 lands the `audit_log` table, update `apps/main/src/lib/db/platform-admin-client.ts:writeAuditRow` to use a separate dedicated service-role client (NOT the wrapped function's `db`, so audit row commits independently of any rolled-back transaction).

**Also stubbed:** Three factory functions throw "not implemented": `tenantContextFromStripeEvent` (lands in BP07), `tenantContextFromInngestEvent` (future Inngest work), `tenantContextForPlatformAdmin` (lands with audit_log in §26).

---

## D-035 — 2026-05-21 — correlation_id uses crypto.randomUUID(), not ULID

**Decision:** `withPlatformAdminAudit` uses `crypto.randomUUID()` for the `correlation_id` field instead of ULID as the spec suggests.

**Why:** Audit rows are stubbed to `console.warn` for now (no DB sort needed). Avoiding the `ulid` npm dependency keeps the lockfile smaller. When `audit_log` lands (D-036), the sortable property of ULIDs becomes useful for time-based audit queries.

**How to apply:** When swapping the audit stub to a real DB insert, also swap `randomUUID()` to a ULID generator. Both changes happen together.

---

## D-034 — 2026-05-21 — tenantClient Proxy deviates from spec §5.4.3 verbatim code

**Decision:** `apps/main/src/lib/db/tenant-client.ts` implements the spec's stated *intent* ("every query is automatically scoped") with a per-operation-method wrapping pattern rather than the spec's literal one-line code.

**Why:** The spec writes `return target.from(table).eq('tenant_id', ctx.tenant_id);` but `.eq()` does not exist on `PostgrestQueryBuilder` (returned by `.from()`) in `@supabase/supabase-js` v2 — it only exists on `PostgrestFilterBuilder` returned after `.select/.update/.delete`. The spec's pattern would fail at runtime with a TypeError. Verified by direct inspection of the Supabase JS proto chain.

**Rejected:** Casting types to make the spec's literal code compile — would produce runtime errors.

**Implementation:** The proxy intercepts `.from(table)` and for tenant-scoped tables returns a wrapped query builder where:
- `.select(...)` / `.update(...)` / `.delete()` → result has `.eq('tenant_id', ctx.tenant_id)` appended automatically
- `.insert(rows)` / `.upsert(rows)` → `tenant_id` injected into payload(s) before delegation

Behavior matches §5.4.3's stated promise; the literal code does not.

**Open follow-up:** §5.4.7 already warns that `.rpc()` and other future query patterns must be added to the proxy. When such patterns get used, extend the wrapper's method intercepts accordingly.

**Artifacts:** `apps/main/src/lib/db/tenant-client.ts`, `apps/main/test/unit/db/tenant-client.test.ts` (6 tests covering both filter-based and payload-injection operations + passthrough).

---

## D-033 — 2026-05-21 — RLS snapshot scope is RLS-tables-and-policies only; SECURITY DEFINER + grants coverage deferred

**Decision:** `scripts/rls-snapshot.ts` captures RLS-enabled state and policy bodies. It does NOT capture SECURITY DEFINER function bodies, search_path settings, or GRANT/REVOKE EXECUTE — those are required by §30.8 but not implemented.

**Why:** The existing rls-snapshot.ts (from §9 / D-021) was scoped narrowly. BP02's `lint:migrations` script provides static-time enforcement of the SECURITY DEFINER convention (§5.1.1) and the no-`USING(true)` rule (§5.1.2), so the snapshot diff is not the only line of defense. Expanding the snapshot to full §30.8 coverage is a separate task.

**Rejected:** Expanding rls-snapshot.ts in BP02 — outside the scope of the build prompt; risks scope creep.

**Follow-up:** When the next round of security hardening lands, extend rls-snapshot.ts to include: (1) pg_proc rows for SECURITY DEFINER functions with body hash + search_path, (2) pg_proc_acl rows for GRANT/REVOKE EXECUTE, (3) information_schema.role_table_grants for explicit table grants.

---

## D-032 — 2026-05-21 — Explicit table grants required for authenticated role on atc-main Supabase

**Decision:** Migration `20260521120003_grants.sql` explicitly grants `SELECT, INSERT, UPDATE, DELETE` on `public.tenants` and `public.users` to the `authenticated` role, and `SELECT` on `public.tier_definitions` to `authenticated` and `anon`.

**Why:** Postgres permission model is two-stage — RLS only applies after the role has the base table privilege. The atc-main Supabase project was provisioned in a state where the standard `ALTER DEFAULT PRIVILEGES` for `authenticated`/`anon` only included metadata grants (REFERENCES, TRIGGER, TRUNCATE), not the data access ones (SELECT/INSERT/UPDATE/DELETE). Without explicit grants, RLS policies were unreachable — every query returned PostgREST error 42501.

**Rejected:** Relying on Supabase's default grants — they were missing on this project for unknown reasons (possibly an older provisioning template).

**How to apply:** Every future migration that creates a tenant-scoped public table must include a matching `GRANT SELECT, INSERT, UPDATE, DELETE ... TO authenticated` statement. The migration lint gate does not yet enforce this — flagged as follow-up.

---

## D-031 — 2026-05-21 — BP02 monorepo + RLS foundations complete

**Decision:** Tenants/users tables with full RLS, two SECURITY DEFINER helper functions, hard-delete trigger, and migration lint gate landed. Deviations from spec:

- **`tier_definitions` is a stub.** Schema is `(id, code, display_name, created_at)` seeded with the six tier codes from §3.3 (`byo_research`, `byo_professional`, `byo_agency`, `sub_starter`, `sub_pro`, `sub_agency`). Spec §5.3 says "Full DDL in repository" but never gives it — will be expanded when Section 14 pricing logic lands.
- **`tenants` RLS has SELECT + UPDATE only** for authenticated role. INSERT runs under service role (signup/admin paths); DELETE is structurally blocked by the §5.1.X trigger. Deviation is documented in the migration file and in the `tenants` table comment per §30.8.
- **Slug regex** was extracted from the spec PDF as `'1[a-z0-9-]{1,28}[a-z0-9]$'`. The leading `1` was treated as a PDF artifact for `^` (start anchor) — actual SQL uses `'^[a-z0-9-]{1,28}[a-z0-9]$'`. User confirmed.
- **Migration runner is a custom TS script** (`scripts/db-migrate.ts`), not the Supabase CLI. Uses the existing `postgres` lib + `SUPABASE_DB_URL` pattern from §9 (D-021), tracks applied versions in `public.schema_migrations`. Rejected: Supabase CLI (would add a second auth surface and conflict with the existing pooler-based connection).
- **`pnpm db:reset` is guarded by `ALLOW_DB_RESET=true`** env flag — refuses to run otherwise. Protects against accidental wipe of the shared atc-main Supabase.
- **Integration tests run live against atc-main Supabase** with random-prefixed ephemeral data (per session decision). 4 tests pass: cross-tenant SELECT denied, suspended-tenant INSERT blocked while SELECT allowed, hard-DELETE raises without override, hard-DELETE succeeds with override.

**Artifacts:** `apps/main/supabase/migrations/{0,1,2,3}*.sql`, `apps/main/test/integration/rls.test.ts`, `scripts/{db-migrate,db-reset,lint-migrations}.ts`, `db/rls-exceptions.txt`, `db/rls-snapshot.sql` regenerated.

**Spec/build-prompt discrepancy noted:** Build prompt says `db/rls-exceptions.txt`; §30.8 says `db/rls-exceptions.sql`. Followed build prompt.

---

## D-030 — 2026-05-21 — Singular VERCEL_PROJECT_ID points at atc-main; rag deploy deferred to BP07

**Decision:** GitHub secret `VERCEL_PROJECT_ID` is set to the `atc-main` project ID (`prj_UoveDAIzVqWYkDGLkLnAG2HM9V7L`). The `atc-rag` project ID (`prj_VM8Fu2flXwtQAIOdCKbJlnwTUmRq`) is captured in this entry for later but not yet wired into `deploy.yml`.

**Why:** `deploy.yml` was written assuming one Vercel project. Right now only `atc-main` deploys — `atc-rag` doesn't yet have anything to deploy. Splitting into `VERCEL_PROJECT_ID_MAIN` / `VERCEL_PROJECT_ID_RAG` and updating deploy.yml is BP07-territory.

**Rejected:** Pre-emptively splitting the secret names and rewriting deploy.yml now — would create churn for no current benefit.

**Both org/project IDs (Vercel team `jharvieux-1491s-projects`):**
- `VERCEL_ORG_ID`: `team_MIXzwKpnQSfuj3hd9ZyWVPPh`
- `atc-main` project ID: `prj_UoveDAIzVqWYkDGLkLnAG2HM9V7L`
- `atc-rag` project ID: `prj_VM8Fu2flXwtQAIOdCKbJlnwTUmRq`

**Artifacts:** GitHub secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` set on `jharvieux-gh/ATC` (2026-05-21). `.vercel/repo.json` produced by `vercel link --cwd apps/{main,rag}` (gitignored).

---

## D-029 — 2026-05-21 — Vercel project names: atc-main and atc-rag

**Decision:** Vercel projects named `atc-main` (root: `apps/main`) and `atc-rag` (root: `apps/rag`).

**Why:** User preference. Spec §1.2 said `main-app` / `rag-service` but names don't affect any code — deploy.yml uses VERCEL_PROJECT_ID env vars, not project names.

---

## D-028 — 2026-05-21 — BP01 monorepo scaffold complete (PR #22)

**Decision:** Monorepo scaffold delivered as pnpm workspace with apps/main, apps/rag, packages/config, packages/shared-types.

**Key deviations from BP01 spec:**
- Node 24 (not 22) — per D-027
- shadcn/ui components (button, card) written manually — no interactive CLI in CI
- `autoprefixer`, `eslint`, `eslint-config-next` added as explicit devDeps in apps — required by pnpm strict hoisting
- `unrs-resolver` build approved in pnpm-workspace.yaml (transitive dep from eslint-config-next)
- Root-level `.eslintrc.json` removed — it was old scaffold, conflicted with app-level configs
- Cross-tenant probe and route enumerator paths updated from `src/app/api` → `apps/main/src/app/api`
- deploy.yml updated from npm+Node20 to pnpm+Node24

**What's next:** BP01 definition of done met locally. Vercel check fails because the two Vercel projects (main-app, rag-service) have not been created yet — user action needed before Vercel deploys will work.

---

## D-027 — 2026-05-20 — Node.js 24 chosen over spec's 22.x

**Decision:** Use Node.js 24 LTS everywhere (local dev + Vercel) instead of 22.x as written in spec §29.2.

**Why:** Vercel's current default is Node 24 LTS. No breaking changes between Node 22 and 24 for Next.js 14. Using the same version locally and on Vercel avoids subtle build divergence.

**Rejected:** Node 22 (spec-exact but older LTS); mismatched versions (local 22 / Vercel 24).

**Impact:** `package.json` `engines.node` will be set to `"24.x"` instead of `"22.x"`.

---

## D-026 — 2026-05-18 — CI/CD Day 0 hardening (S-1, CR-1, CR-3a, HI-6, ME-15)

**Decision:** Applied all Day 0 items from CI/CD Pipeline Fix Prompts (red team remediation).

- **S-1:** `scripts/staging-fixups.sql` updated for v6.1 schema: `agent_organizations` → `tenants` (adds `stripe_connect_account_id` nulling), `email_messages` → `email_log` (status `ignored` → `suppressed`, filter updated to v6.1 active statuses `queued`/`sent`), `email_connections` block wrapped in defensive DO block, new section 4 clears `auth.identities` OAuth tokens.
- **CR-1:** `release/*` branch protection enabled on GitHub (PR required, status checks, stale dismissal, conversation resolution). Push restriction not available on Free plan — accepted gap, noted for Pro upgrade.
- **CR-3a:** `.github/CODEOWNERS` created; `@jharvieux` required reviewer for `.github/workflows/`, `CODEOWNERS` itself, and `scripts/staging-fixups.sql`.
- **HI-6:** Backup production approver added to `production` GitHub Environment.
- **ME-15:** All 12 required GitHub labels pre-created.

**Why:** Red team review (Part B) identified these as Day 0 prerequisites blocking all subsequent CI/CD hardening work.

**Rejected:** Push restriction on `release/*` — not available on GitHub Free for private repos.

**Artifacts:** `scripts/staging-fixups.sql`, `.github/CODEOWNERS`. PR #18 merged to dev.

---

## D-025 — 2026-05-16 — §13 rollback runbooks shipped as documentation only

**Decision:** All three rollback runbooks and `check-production-version.sh` are docs/scripts only — no CI gate, no automation. The database rollback runbook recommends compensating migrations over point-in-time restore; point-in-time is documented as last resort with an explicit data-loss warning.

**Why:** §13 is purely operational documentation, not a CI feature. Screenshot placeholders are intentional — they will be filled in when a real production deployment exists.

**Rejected:** Automating any rollback steps. Rollback is a human judgment call that must not be triggered automatically.

**Artifacts:** `docs/runbooks/rollback-application.md`, `docs/runbooks/cancel-before-production.md`, `docs/runbooks/rollback-database.md`, `scripts/check-production-version.sh`. PR #16 merged to dev.

---

## D-024 — 2026-05-16 — §12 AI Eval Harness deferred; design-only deliverable

**Decision:** §12 ships as design doc only (`docs/evals/design.md`). No eval runner, no judge module, no CI gate, no eval snapshots, no SQL migration. The implementation is deferred until `src/prompts/`, `src/tools/`, and conversation tables exist.

**Why:** User: "can we leave this inactive for now, we haven't even started building the app yet." No point building an eval harness before there is anything to evaluate.

**Key design choices locked in (for when implementation resumes):**

- Storage: Supabase atc-test (not prod), three tables: eval_runs, eval_results, drift_stats
- Scoring: hybrid — single Sonnet judge for standard evals, 3-judge ensemble for safety-critical
- Regression threshold: ≥5% OR ≥10 absolute flip pass→fail; any single safety-critical flip blocks
- Daily sampling: deferred entirely (no cron, no sampling job)
- Gate: warn-only for 30+ days after implementation, then flip to blocking once stable
- Cost target: ~$250/month at 20 PRs/month (Sonnet judge, Haiku for sampling)

**Rejected:** Building stub infrastructure that passes CI — user wanted nothing, not a skeleton.

**Artifacts:** `docs/evals/design.md`, PR #15 merged to dev.

---

## D-023 — 2026-05-16 — §11 contract tests: all tests skipped pending SDK wrappers

**Decision:** Contract test infrastructure (MSW server, fixture files, test files) is fully in place. All 13 test cases are `.skip()`-ed pending `src/lib/stripe/` and `src/lib/anthropic/` wrappers. The nightly contracts-canary workflow runs with `continue-on-error: true` during rollout.

**Artifacts:** `tests/contracts/`, `tests/contracts/fixtures/`, `scripts/record-contracts.ts`, `.github/workflows/contracts-canary.yml`. PR #14 merged to dev.

**Pending:** `STRIPE_TEST_SECRET_KEY` repo secret not yet added — user did not have it at time of §11 execution.

---

## D-022 — 2026-05-16 — §10 cross-tenant probe: static enumeration + skipped live probe

**Decision:** Cross-tenant probe uses static file scanning (no real HTTP calls in CI). Live probe test is skipped behind `CROSS_TENANT_FIXTURES=true` flag pending application schema. Allowlist is empty JSON; will be populated as routes are added.

**Artifacts:** `scripts/enumerate-api-routes.ts`, `tests/security/cross-tenant-probe.test.ts`, `tests/security/cross-tenant-allowlist.json`. PR #13 merged to dev.

---

## D-021 — 2026-05-16 — §9 RLS snapshot: postgres npm package over Supabase client

**Decision:** `scripts/rls-snapshot.ts` uses the `postgres` npm package with a direct DB connection, not the Supabase JS client. PostgREST does not expose `pg_catalog` tables (pg_policy, pg_class), so Supabase client cannot query them.

**Why:** Tried Supabase client first; confirmed pg_catalog is inaccessible via PostgREST. Direct postgres connection is the only path.

**Constraint:** `SUPABASE_TEST_DB_URL` must be set to the connection pooler URL (session mode, port 5432, `aws-0-[region].pooler.supabase.com`) — NOT the direct connection URL, which resolves to IPv6 unreachable from GitHub Actions runners.

**Artifacts:** `scripts/rls-snapshot.ts`, `scripts/rls-snapshot-diff.ts`, `db/rls-snapshot.sql`. PR #12 merged to dev.

---

## D-020 — 2026-05-16 — §8 CVE scan: npm audit, critical=fail, high=warn

**Decision:** CVE scan uses `npm audit --audit-level=critical` (exit 1 on critical). High-severity findings emit `::warning::` GitHub annotations but do not fail the build. Suppressions tracked in `docs/security/cve-suppressions.md`.

**Artifacts:** `docs/security/cve-suppressions.md`, `docs/security/risk-acceptance.md`. PR #11 merged to dev.
