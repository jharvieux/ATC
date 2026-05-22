# CCPA Staging Cleanup Runbook

**Purpose:** Manually propagate CCPA data deletions to staging when the automated staging-refresh pipeline has not run within 25 days.

**SLA:** CCPA deletion requests must be fully propagated within 45 days. This runbook covers the manual path when the CI/CD pipeline hasn't refreshed staging automatically.

**Trigger:** The `ccpa-staging-propagation-monitor` Inngest cron emits a `console.warn` alert when `platform_settings.last_staging_refresh_at` is more than 25 days old AND users with pending deletions exist.

---

## When to Run

Run this runbook when you see the following alert in logs or monitoring:

```
[ccpa-staging-monitor] ALERT: staging last refreshed X days ago (threshold: 25d). N user(s) with pending CCPA deletions...
```

---

## Prerequisites

- Access to the atc-main staging Supabase project.
- The `scripts/staging-fixups.sql` script (in repo root). This script already handles suppressed/deleted users — Section 4 of the script covers CCPA deletion propagation.
- A Supabase DB connection URL for the **staging** project.

---

## Steps

### 1. Identify deleted users in production

```sql
-- Run against the PRODUCTION Supabase:
SELECT auth_user_id, deleted_at
FROM public.users
WHERE deleted_at IS NOT NULL
  AND deleted_at <= NOW() - interval '1 day'
ORDER BY deleted_at;
```

Note the `auth_user_id` values.

### 2. Apply the staging fixups

The automated staging refresh would normally do this. Manually run:

```bash
SUPABASE_DB_URL="<staging-pooler-url>" psql "$SUPABASE_DB_URL" < scripts/staging-fixups.sql
```

The staging-fixups script handles user deletion propagation (Section 4 clears OAuth tokens for deleted users).

### 3. Manually null out deleted user data on staging

For each deleted user identified in Step 1:

```sql
-- Run against the STAGING Supabase:
UPDATE auth.users SET email = NULL, phone = NULL WHERE id = '<auth_user_id>';
UPDATE public.users SET deleted_at = NOW() WHERE auth_user_id = '<auth_user_id>';

-- Anonymize bookings
UPDATE public.bookings SET auth_user_id = NULL WHERE auth_user_id = '<auth_user_id>';

-- Delete conversations
DELETE FROM public.messages WHERE conversation_id IN (
  SELECT id FROM public.conversations WHERE auth_user_id = '<auth_user_id>'
);
DELETE FROM public.conversations WHERE auth_user_id = '<auth_user_id>';

-- Delete consent records
DELETE FROM public.legal_consents WHERE auth_user_id = '<auth_user_id>';
```

### 4. Update the staging refresh timestamp

After completing the manual propagation, update the tracking timestamp:

```sql
-- Run against PRODUCTION Supabase:
INSERT INTO public.platform_settings (key, value)
VALUES ('last_staging_refresh_at', NOW()::text)
ON CONFLICT (key) DO UPDATE SET value = NOW()::text;
```

### 5. Verify

Check that the staging monitor will not re-alert:

```sql
-- Run against PRODUCTION:
SELECT value FROM public.platform_settings WHERE key = 'last_staging_refresh_at';
```

The value should be recent (within the last few minutes).

---

## Notes

- The `purgeUserDataPerRetention` function (called by the Inngest `user-data-purge-after-grace` job) handles production-side deletion. This runbook is only for propagating those deletions to **staging**.
- The staging-fixups.sql script is documented in the CI/CD pipeline spec §9.5 (see `specs/BuildPrompts/build-prompts-part-7-prompt-29.md` for the pipeline build).
- CCPA §17.10 requires a 45-day maximum from deletion request to full propagation. This runbook is a manual safety net — the primary path is the automated release pipeline refresh.
- If the release pipeline CI/CD §29 is not yet built, this runbook is the **only** mechanism for staging propagation. Track manually and run at least every 20 days.
