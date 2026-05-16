-- =============================================================================
-- staging-fixups.sql
-- =============================================================================
-- Run by: .github/workflows/deploy.yml, db-copy job, step "Apply staging fixups"
-- When:   Immediately after pg_restore copies the production database to staging.
-- Why:    Prevent staging from touching live external services (Gmail, Stripe)
--         and from processing real production customer emails.
--
-- Safe to run multiple times (all updates are idempotent).
-- =============================================================================

-- =============================================================================
-- 1. Clear Gmail OAuth tokens in email_connections
-- =============================================================================
-- Production and staging use different GMAIL_ENCRYPTION_KEY values, so any
-- token copied from production will fail to decrypt on staging. Setting them
-- to NULL and marking the connection as reconnect_required is cleaner than
-- allowing silent decryption failures. This also prevents the gmail-renew
-- Inngest job from attempting OAuth refreshes against production Google tokens.
-- =============================================================================

UPDATE email_connections
SET
    access_token        = NULL,
    refresh_token       = NULL,
    connection_status   = 'reconnect_required',
    last_error          = 'Staging: tokens cleared after DB copy from production',
    last_error_at       = NOW(),
    updated_at          = NOW();

-- =============================================================================
-- 2. Clear Stripe customer references in agent_organizations
-- =============================================================================
-- Staging uses Stripe test-mode API keys, which cannot look up live-mode
-- customer or subscription IDs copied from production. Leaving them in place
-- would cause every Stripe call on staging to return a "no such customer"
-- error. Clearing them forces staging to create fresh test-mode resources.
-- =============================================================================

UPDATE agent_organizations
SET
    stripe_customer_id      = NULL,
    stripe_subscription_id  = NULL,
    updated_at              = NOW();

-- =============================================================================
-- 3. Suppress unprocessed customer emails in email_messages
-- =============================================================================
-- Staging must not categorize, draft replies for, or send responses to real
-- production customer emails. Marking unprocessed messages as 'ignored'
-- prevents the email-processing pipeline from acting on them. Messages that
-- are already processed (sent, archived, etc.) are left unchanged.
-- =============================================================================

UPDATE email_messages
SET status = 'ignored'
WHERE status IN ('unread', 'triaged', 'draft_ready');

-- =============================================================================
-- 4. Verification — confirm all fixups applied correctly
-- =============================================================================
-- Each row reports the count of records that should be zero after the fixups.
-- If any count is non-zero, the corresponding fixup did not fully apply.
-- This output is visible in GitHub Actions logs for the db-copy job.
-- =============================================================================

SELECT 'email_connections_with_tokens'   AS check_name,
       COUNT(*)                          AS remaining_count
FROM   email_connections
WHERE  access_token IS NOT NULL
   OR  refresh_token IS NOT NULL

UNION ALL

SELECT 'agent_organizations_with_stripe_refs' AS check_name,
       COUNT(*)                               AS remaining_count
FROM   agent_organizations
WHERE  stripe_customer_id IS NOT NULL
   OR  stripe_subscription_id IS NOT NULL

UNION ALL

SELECT 'email_messages_unprocessed'  AS check_name,
       COUNT(*)                      AS remaining_count
FROM   email_messages
WHERE  status IN ('unread', 'triaged', 'draft_ready');
