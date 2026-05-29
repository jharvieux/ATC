# Runbook — Migrate the nightly DB-backed suites off the prod-serving `atc-main` DB

**Status:** REQUIRED before customer data is loaded into `atc-main`.
**Owner:** operator (platform/infra). Not automatable — every step needs the Supabase dashboard or the GitHub repo secret store.
**Refs:** decision **D-112**, implementing PR **#385**, tracking issue **#386**.

---

## Why this exists

PR #385 (D-112) wired `SUPABASE_DB_URL` into `.github/workflows/nightly-full-test.yml` so the DB-backed Tier-2 suites (RLS, the service-role proxy suite, and the four cross-tenant Inngest probes) actually run instead of silently `describe.skip`-ing.

There is no dedicated test Supabase project yet, so the nightly currently points at the **prod-serving `atc-main` project** (ref `mfaknjyqiwcjojukcnea`). This was accepted as a **pre-launch exception**: the recreated DB holds no valuable or customer data today, so a destructive nightly run is harmless.

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

Harmless on an empty pre-launch DB. **Dangerous the moment real tenant data lands** — a nightly run would mutate or delete production tenant data. This migration must complete before any customer data is loaded.

---

## How the workflow consumes the secrets (current wiring — already correct)

`.github/workflows/nightly-full-test.yml` already reads the dedicated test-project secret names; only the **values** currently point at `atc-main`. No workflow edit is required by this runbook — you are repointing secret *values*, not rewiring YAML.

```yaml
# .github/workflows/nightly-full-test.yml (job env)
NEXT_PUBLIC_SUPABASE_URL:      ${{ secrets.SUPABASE_TEST_URL }}
NEXT_PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_TEST_ANON_KEY }}
SUPABASE_SERVICE_ROLE_KEY:     ${{ secrets.SUPABASE_TEST_SERVICE_KEY }}
SUPABASE_DB_URL:               ${{ secrets.SUPABASE_TEST_DB_URL }}
```

The seed step runs `pnpm tsx scripts/seed-tier2-test.ts` against whatever those secrets resolve to.

---

## Procedure

### 1. Stand up a dedicated test Supabase project

- Region **us-east-1** (matches the existing project; keeps GitHub Actions runner latency low).
- Apply the full schema to the new project (migrations under `db/` — run the same migration path used to recreate `atc-main`). The schema must match prod so RLS and the proxy suite exercise the real policies.
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

### 5. (Low priority) Sweep orphaned fixtures from the old `atc-main` DB

Prior failed RLS-suite teardowns left orphaned `rlstest-*` tenants and `tenant_usage_metrics` rows in the prod-serving `atc-main` DB. They are harmless (the nightly crons process them), but once the dedicated project is live, sweep them so the prod-serving DB is clean before customer data lands:

- Delete `tenants` rows where the slug/name matches `rlstest-*`, plus their dependent rows (`tenant_usage_metrics` and anything else FK-bound to those tenant ids).
- Do this against `atc-main` as a **read-checked, explicit** delete — confirm the row set with a `SELECT` first. Per repo policy, only run reads against `atc-prod`; this cleanup targets `atc-main`, not `atc-prod`.

---

## Verification checklist

- [ ] New test project exists in us-east-1 with the prod-matching schema applied.
- [ ] All four `SUPABASE_TEST_*` secrets resolve to the new project.
- [ ] `SUPABASE_TEST_DB_URL` is the session-mode pooler URL on port 5432 (not the IPv6 direct connection).
- [ ] A `workflow_dispatch` nightly run is green, with the DB-backed suites executing (not skipped).
- [ ] `atc-main` swept of orphaned `rlstest-*` tenants and their `tenant_usage_metrics` rows.

## Rollback

If the new project misbehaves and the nightly must keep running in the interim, repoint the four secret values back to the `atc-main` (`mfaknjyqiwcjojukcnea`) credentials. This is safe **only** while `atc-main` still holds no customer data — once data is loaded, a broken nightly should be left red rather than pointed back at the prod-serving DB.
