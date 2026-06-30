-- =============================================================================
-- staging-fixups.sql
-- =============================================================================
-- Run by: .github/workflows/deploy.yml, db-copy job, step "Apply staging fixups"
-- When:   Immediately after pg_restore copies the production database to staging.
-- Why:    Prevent staging from touching live external services (Gmail, Stripe,
--         Google/Microsoft/Facebook OAuth) and from processing real production
--         customer emails.
--
-- Safe to run multiple times (all updates are idempotent).
--
-- Schema note: updated for v6.1 (AI_Travel_Concierge_Spec_v6_1_Full.docx §5).
--   agent_organizations → tenants (§5.1)
--   email_messages      → email_log (§23.2)
--   email_connections   → possibly absent in v6.1; handled defensively below
-- =============================================================================


-- =============================================================================
-- 1. Clear Gmail OAuth tokens in email_connections
-- =============================================================================
-- Production and staging use different GMAIL_ENCRYPTION_KEY values, so any
-- token copied from production will fail to decrypt on staging. Clearing them
-- prevents silent decryption failures and stops the gmail-renew Inngest job
-- from attempting OAuth refreshes against production Google tokens.
--
-- DEFENSIVE: email_connections may not exist in v6.1 (table is not in §5 DDL).
-- This block no-ops cleanly if the table is absent and logs a NOTICE so the
-- operator knows to verify whether Gmail integration is intentionally missing.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'email_connections'
      AND n.nspname = 'public'
      AND c.relkind = 'r'
  ) THEN
    UPDATE public.email_connections
    SET
        access_token        = NULL,
        refresh_token       = NULL,
        connection_status   = 'reconnect_required',
        last_error          = 'Staging: tokens cleared after DB copy from production',
        last_error_at       = NOW(),
        updated_at          = NOW();
  ELSE
    RAISE NOTICE 'email_connections table not present — skipping Gmail token clear. '
                 'Verify Gmail integration is intentionally absent or update fixup.';
  END IF;
END $$;


-- =============================================================================
-- 2. Clear Stripe references in tenants
-- =============================================================================
-- Staging uses Stripe test-mode API keys, which cannot look up live-mode
-- customer, subscription, or Connect account IDs copied from production.
-- Leaving them in place causes every Stripe call on staging to return a
-- "no such customer" or "no such account" error. Clearing them forces staging
-- to create fresh test-mode resources.
--
-- stripe_connect_account_id is also cleared: a live Connect account ID on
-- staging would allow money-movement calls against the real Connect account,
-- which is the higher-risk of the two Stripe identifier types.
-- =============================================================================

UPDATE public.tenants
SET
    stripe_customer_id          = NULL,
    stripe_subscription_id      = NULL,
    stripe_connect_account_id   = NULL,
    updated_at                  = NOW();


-- =============================================================================
-- 3. Suppress unprocessed customer emails in email_log
-- =============================================================================
-- Staging must not send real production customer emails. Setting status to
-- 'suppressed' (a valid terminal status per §23.2 email_log CHECK constraint)
-- prevents the email pipeline from picking up and sending these rows.
--
-- Filter: 'queued' (waiting to send) and 'sent' (sent but not yet delivered-
-- confirmed) are the only non-terminal statuses in v6.1.
-- All other statuses (delivered, soft_bounced, hard_bounced, complained,
-- rejected, suppressed) are already terminal — no pipeline action needed.
--
-- Schema migration note: the previous schema used status values 'unread',
-- 'triaged', and 'draft_ready' in a table called email_messages. Those values
-- do not exist in v6.1's email_log CHECK constraint and have been removed here.
-- =============================================================================

UPDATE public.email_log
SET status = 'suppressed'
WHERE status IN ('queued', 'sent');


-- =============================================================================
-- 4. Clear OAuth provider tokens in auth.identities
-- =============================================================================
-- Supabase copies auth.identities from production. provider_token and
-- provider_refresh_token allow staging to impersonate real users against
-- Google, Microsoft, and Facebook. Clearing them prevents staging from
-- making authenticated calls to those providers on behalf of production users.
--
-- DEFENSIVE: provider_token/provider_refresh_token column presence varies
-- across Supabase versions. This block no-ops if the columns are absent.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth'
      AND table_name   = 'identities'
      AND column_name  = 'provider_token'
  ) THEN
    UPDATE auth.identities
    SET
        provider_token         = NULL,
        provider_refresh_token = NULL
    WHERE provider_token IS NOT NULL
       OR provider_refresh_token IS NOT NULL;
  ELSE
    RAISE NOTICE 'auth.identities.provider_token column not present — '
                 'skipping OAuth token clear. Verify Supabase version.';
  END IF;
END $$;


-- =============================================================================
-- 5. Verification — confirm all fixups applied correctly
-- =============================================================================
-- Each row reports the current count for key post-fixup conditions.
-- These rows are visible in GitHub Actions logs for the db-copy job.
--
-- email_connections_with_tokens: should be 0 (or 'N/A' if table absent)
-- tenants_with_stripe_customer_id: should be 0
-- tenants_with_stripe_connect_account_id: should be 0 (new in v6.1)
-- email_log_active_statuses: should be 0
-- =============================================================================

-- Presence check only — do NOT SELECT FROM public.email_connections here.
-- Postgres resolves table references at PARSE time, so a direct reference
-- errors ("relation does not exist") when the table is absent (v6.1), even
-- inside a CASE WHEN EXISTS guard. Step 1 already clears the tokens defensively;
-- this row just reports whether the table is present.
SELECT 'email_connections_table' AS check_name,
       COALESCE(
         (SELECT 'present'
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = 'email_connections'
            AND n.nspname = 'public'
            AND c.relkind = 'r'),
         'N/A — table not present'
       ) AS result

UNION ALL

SELECT 'tenants_with_stripe_customer_id' AS check_name,
       COUNT(*)::TEXT AS result
FROM   public.tenants
WHERE  stripe_customer_id IS NOT NULL

UNION ALL

SELECT 'tenants_with_stripe_connect_account_id' AS check_name,
       COUNT(*)::TEXT AS result
FROM   public.tenants
WHERE  stripe_connect_account_id IS NOT NULL

UNION ALL

SELECT 'email_log_active_statuses' AS check_name,
       COUNT(*)::TEXT AS result
FROM   public.email_log
WHERE  status IN ('queued', 'sent');

-- =============================================================================
-- 6. Re-create E2E test user row in public.users
-- =============================================================================
-- db-copy wipes public.users along with the rest of the public schema.
-- The E2E test account lives in auth.users (not copied — staging's auth.users
-- is left intact after the restore), so GoTrue password sign-in still works.
-- But getCachedUser() resolves the session via a public.users lookup, so the
-- row must be re-created here or every authed E2E test fails with a null user.
--
-- :e2e_email is passed as a psql -v variable from the db-copy workflow step.
-- If unset (local runs, non-E2E pipelines) the block no-ops safely.
-- =============================================================================
DO $$
DECLARE
  v_email     TEXT := current_setting('e2e_email', true);
  v_auth_id   UUID;
  v_tenant_id UUID;
BEGIN
  IF v_email IS NULL OR v_email = '' THEN
    RAISE NOTICE 'e2e_email not set — skipping E2E user fixup.';
    RETURN;
  END IF;

  SELECT id INTO v_auth_id FROM auth.users WHERE email = v_email;
  IF v_auth_id IS NULL THEN
    RAISE NOTICE 'E2E auth.users row not found for % — skipping.', v_email;
    RETURN;
  END IF;

  SELECT id INTO v_tenant_id FROM public.tenants LIMIT 1;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'No tenants found after restore — cannot create E2E user row.';
  END IF;

  INSERT INTO public.users (auth_user_id, tenant_id, email, role)
  VALUES (v_auth_id, v_tenant_id, v_email, 'tenant_owner')
  ON CONFLICT (auth_user_id, tenant_id) DO UPDATE SET role = 'tenant_owner';

  RAISE NOTICE 'E2E user re-created: % → tenant %', v_email, v_tenant_id;
END $$;
