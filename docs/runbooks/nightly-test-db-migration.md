# Nightly test-DB migration record and recovery runbook

Keep the nightly DB-backed suites on the dedicated test/staging database and recover that boundary if its project or credentials must be replaced.

**Owner:** operator (platform/infra) — not automatable; every recovery step needs the Supabase dashboard or the GitHub repo secret store.
**Status:** COMPLETED by D-257; issue #386 is closed. Retain this as the credential-rotation and disaster-recovery procedure.
**Refs:** D-112, D-257, PR #385, issue #386.

---

## Why this exists

PR #385 (D-112) wired `SUPABASE_DB_URL` into `.github/workflows/nightly-full-test.yml` so the DB-backed Tier-2 suites (RLS, the service-role proxy suite, and the four cross-tenant Inngest probes) actually run instead of silently `describe.skip`-ing.

D-257 provisioned the dedicated test/staging Supabase project and removed the pre-launch exception that pointed these suites at the prod-serving `atc-main` project. The workflow must continue resolving every `SUPABASE_TEST_*` secret to the dedicated project.

The nightly invokes **real, destructive global crons** against whatever DB the secrets resolve to, on every run:

| Cron | Effect |
|------|--------|
| `billingPeriodRollover` | iterates **every** tenant |
| `abuseRecomputeNightly` | iterates **every** tenant |
| `helpDocVersionsPurge` | **PURGE** |
| `helpSubmissionDailyReset` | **RESET** |
| `bookingCommissionRetentionPurge` | delete |
| `forensicsLogPurgeCron` | delete |
| `userDataPurgeAfterGrace` | delete |

These operations are safe only on the disposable test/staging database. Pointing them at a production-serving project could mutate or delete tenant data.

---

## How the workflow consumes the secrets (current wiring — already correct)

`.github/workflows/nightly-full-test.yml` reads the dedicated test-project secret names. Their values must remain bound to the test/staging project. Recreating the project requires rotating secret *values*, not rewiring YAML.

```yaml
# .github/workflows/nightly-full-test.yml (job env)
NEXT_PUBLIC_SUPABASE_URL:      ${{ secrets.SUPABASE_TEST_URL }}
NEXT_PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_TEST_ANON_KEY }}
SUPABASE_SERVICE_ROLE_KEY:     ${{ secrets.SUPABASE_TEST_SERVICE_KEY }}
SUPABASE_DB_URL:               ${{ secrets.SUPABASE_TEST_DB_URL }}
```

The seed step runs `pnpm tsx scripts/seed-tier2-test.ts` against whatever those secrets resolve to.

---

## Recovery procedure

Use this procedure only when recreating the dedicated project or rotating its credentials. The initial migration is already complete.

### 1. Stand up a dedicated test Supabase project

- Region **us-east-1** (matches the existing project; keeps GitHub Actions runner latency low).
- Apply the full schema from `apps/main/supabase/migrations/` using the same reset/apply path as the shared test database. The schema must match production so RLS and the proxy suite exercise the real policies.
- Do **not** load any customer or production data. This project exists solely to be repeatedly mutated and purged by the nightly.

### 2. Repoint the four GitHub Actions secrets

In the repo **Settings → Secrets and variables → Actions**, update the **values** of:

| Secret | New value |
|--------|-----------|
| `SUPABASE_TEST_URL` | new project URL (`https://<new-ref>.supabase.co`) |
| `SUPABASE_TEST_ANON_KEY` | new project anon key |
| `SUPABASE_TEST_SERVICE_KEY` | new project service-role key |
| `SUPABASE_TEST_DB_URL` | new project DB URL — **see the pooler caveat below** |

> **Pooler caveat (this is the one that bites):** `SUPABASE_TEST_DB_URL` MUST be the **session-mode pooler** URL on **port 5432**. The IPv6 direct-connection string Supabase shows by default is **unreachable from GitHub Actions runners** (they are IPv4-only). Use the connection string labelled *Session mode* / *Shared Pooler* in the dashboard (`...pooler.supabase.com:5432`), not the *Direct connection* string. A direct-connection URL will fail the nightly with a connection timeout, not an auth error — so it can look like a credentials problem when it is actually a reachability problem.

Treat all four values as secrets: paste them straight into the GitHub secret store, never echo them into a terminal, a commit, or this file.

### 3. Confirm the seed script targets the new project

`scripts/seed-tier2-test.ts` seeds the two-tenant fixture the RLS and cross-tenant suites depend on. It reads the same `SUPABASE_TEST_*` env the workflow injects, so once step 2 is done it will target the new project automatically. No code change expected — just confirm the script still runs clean against the new schema (a missing table or column will surface here first).

### 4. Dispatch the nightly once and confirm green

- Trigger `nightly-full-test.yml` via **workflow_dispatch** (Actions tab → the nightly workflow → *Run workflow*).
- Confirm the run is green end-to-end, specifically that the previously-skipped DB-backed suites (RLS, proxy, the four cross-tenant Inngest probes) now **execute** rather than skip.
- If `SUPABASE_TEST_DB_URL` was set to a direct-connection string, this is where it fails — re-check the pooler caveat in step 2.

## Verification checklist

- [ ] New test project exists in us-east-1 with the prod-matching schema applied.
- [ ] All four `SUPABASE_TEST_*` secrets resolve to the new project.
- [ ] `SUPABASE_TEST_DB_URL` is the session-mode pooler URL on port 5432 (not the IPv6 direct connection).
- [ ] A `workflow_dispatch` nightly run is green, with the DB-backed suites executing (not skipped).

## Rollback

If the test project misbehaves, leave the nightly red while repairing or recreating that project. Do not repoint destructive suites to `atc-main` or another production-serving database.
