-- Migration: email_retry_content_completed_attempt
-- Version:   20260722000018
-- Generated: 2026-07-13T00:10:14Z by scripts/new-migration.sh
-- Branch:    feature/sweep-email-1611
-- Worktree:  agent-ad0a4dba63922f6c7
--
-- §23.7 / #1611 — soft-bounce retry completion marker (round-2 audit fix).
--
-- claimed_attempt (added in 20260722000017) only ORDERS attempts; it cannot
-- distinguish "this attempt is fully done" from "a prior run claimed this attempt
-- then crashed mid-send". The re-entrant CAS fallback in soft-bounce-retry.ts
-- therefore re-ran sendEmail on EVERY zero-row claim where the current claim
-- equals this attempt — including the common "already completed" case — inserting
-- an orphaned email_log row and bumping incrementEmailSent (neither is covered by
-- the Resend Idempotency-Key, which dedupes only the vendor delivery).
--
-- completed_attempt is the completion marker: the retry handler writes it AFTER
-- scheduleNext lands. The ambiguous-claim branch reads it — completed_attempt >=
-- the attempt means "fully processed, do not re-send" (claim_lost); a lower value
-- with claimed_attempt == the attempt is the genuine crash signature that must
-- resume. Nullable, no default: NULL = "no attempt has completed yet".
--
-- Expand-only: adds a nullable column. No policy/grant change (the table's
-- service-role-only RLS + grants already cover every column), so no snapshot
-- regeneration is required.

ALTER TABLE public.email_retry_content
  ADD COLUMN IF NOT EXISTS completed_attempt INTEGER;
