# §25.10 Staging real-PII risk acceptance

The staging environment runs against a periodic restored copy of production data, which means **real PII lives in staging by design**. The risk is accepted on the condition that all the controls below are demonstrably in place. This runbook is the audit trail.

## Controls

### 1. Outbound isolation (email + SMS)

**Email** — wired in `apps/main/src/lib/email/send.ts`:

```ts
const stagingOverrideTo =
  process.env.STAGING_MODE === "true" ? process.env.TEST_OVERRIDE_EMAIL : null;
const effectiveTo = stagingOverrideTo ?? to;
```

Verified by the BP25 unit test `send-staging-override.test.ts`: when `STAGING_MODE=true` and `TEST_OVERRIDE_EMAIL` is set, every outbound goes to the override address and the subject is prefixed `[STAGING → original-recipient@example.com]` so the test recipient can tell who would have been hit in prod.

**SMS** — no SMS sender wired today. When one lands, add the parallel `TEST_OVERRIDE_PHONE` redirect at the call site. The env var is declared and defaulted in `apps/main/src/lib/env.ts`.

### 2. External-service neutering

Stripe, Resend, OpenAI, Anthropic, GCV, Vercel API calls all use distinct staging credentials in the staging Vercel project — never prod creds.

This control is verified at the CI/CD pipeline level (separate pipeline doc); BP25 ships the dependency note.

### 3. Background-job suppression

All Inngest crons created in BP25 (`anonymous-session-cleanup`, `rag-rejected-items-purge`, `booking-commission-retention-purge`) include the standard pattern:

```ts
if (process.env.STAGING_MODE === "true") {
  await svc.from("staging_cron_skips").insert({ cron_id: "<this-cron-id>" });
  return { skipped_for_staging: true };
}
```

The `staging_cron_skips` table makes skipped runs visible from the staging admin UI.

**Earlier-prompt crons** that mutate production-shaped data also need this guard. The BP26 work will audit each pre-BP25 cron and add the check where needed; see MEMORY D-058 for the running list.

### 4. Access scope

The staging Vercel project has its own URL and is gated by:
- IP allow-list (operator network, plus VPN exits used by employees)
- Separate Supabase project ID + service role key
- Banner injected at root layout level in staging (TODO(operator)) indicating "STAGING — real customer data, do not share screenshots externally"

### 5. Refresh hygiene

The CI/CD pipeline owns the staging refresh schedule. The refresh script (BP CI/CD) runs `scripts/staging-fixups.sql` after each restore — clears `auth.identities` OAuth tokens, nulls Stripe Connect account IDs, marks email log rows as suppressed.

The CCPA staging-propagation monitor (`ccpa-staging-propagation-monitor` Inngest cron from BP17) alerts at day 25 if the last refresh stamp in `platform_settings.last_staging_refresh_at` is overdue — protects the 45-day CCPA SLA.

## Review cadence

- Quarterly: verify all five controls still hold; re-run the override unit test.
- Whenever a new outbound integration is added: add the corresponding staging override at the call site BEFORE the integration ships to staging.

## Acceptance

- [ ] Operator acceptance signature, date.
- [ ] Counsel acceptance signature, date.
