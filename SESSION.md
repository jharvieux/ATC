# Session state — last updated 2026-05-23

## Just completed
- BP25: CCPA retention closeout, free-text anonymization, forensics capture (§25) — PR #73 merged to dev
  - Migration 20260604000000_retention_ccpa_forensics.sql: ccpa_deletion_executions, forensics_log (BP26 owns decrypt), bookings/commissions anonymized_customer_hash, quotes.narrative (new column), contacts.notes + contacts.anonymized_customer_hash (Category 3 surface), users phone + deleted_purged_at + cookie_preferences + performance_analytics_opt_out + status='purged', staging_cron_skips
  - 4 new env vars + boot-time guard: PLATFORM_PEPPER (never-rotate), FORENSICS_ENCRYPTION_KEY_CURRENT/_PRIOR_1/_PRIOR_2, key separation check per §26.5a
  - lib/privacy/customer-hash + forensics/capture + purge-user-data (10-step purge with forensics-snapshot-on-dispute, three-category anonymization, transaction-shape per-step error handling)
  - user-data-purge-after-grace cron wired to real purge; fans out notifications to affected tenants
  - 4 retention crons: anonymous-session-cleanup (60d), rag-rejected-items-purge (90d), booking-commission-retention-purge (7y with dispute guard), subprocessors-annual-review (Jan 1) — all with STAGING_MODE skip
  - Cookie consent banner wired into root layout + /settings/privacy + /settings/privacy/cookies + cookie_preferences mirror
  - /tenant-admin/crm/anonymized-notes review page with inline redaction
  - Breach response runbook + BreachNotificationUser/TenantAdmin templates + sendBreachNotifications helper
  - Staging outbound isolation wired in lib/email/send.ts; staging-pii-risk-acceptance runbook
  - /legal/sub-processors public page
  - 4 new test files, 16 new tests; all 483 tests pass; typecheck/lint/lint:migrations all clean
  - MEMORY D-058 added with 16 decisions

## In flight
- Nothing in flight — clean checkpoint

## Next step
- BP26 — second prompt in Part 6 (security §26). Uses Opus 4.7 — stay on current model.

## Blocked on user
- Nothing

## Open questions
- Operator tasks for BP25 (not code):
  - Generate `PLATFORM_PEPPER` (256-bit random) and `FORENSICS_ENCRYPTION_KEY_CURRENT` (32-byte base64); set in Vercel staging + production
  - **NEVER rotate `PLATFORM_PEPPER`** — store in 1Password with explicit "do not rotate" note (D-058 #1)
  - Apply migration 20260604000000_retention_ccpa_forensics.sql to atc-main
  - Set `STAGING_MODE=true` + `TEST_OVERRIDE_EMAIL` in the staging Vercel project
  - Engage counsel on breach notification template wording (TODO(legal-counsel))
  - Populate `docs/runbooks/breach-response.md` contact list + `docs/cookies-inventory.md` stub
- Carry-over: audit_log table real-INSERT swap when §26 lands (D-036, D-053, D-056, D-057, D-058), retrieval-log aggregation needs RAG-side Inngest (D-058), no formal tenant_admin role yet (RBAC ships in §26), no SMS sender yet so TEST_OVERRIDE_PHONE is reserved
