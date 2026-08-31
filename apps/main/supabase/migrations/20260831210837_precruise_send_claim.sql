-- Migration: precruise_send_claim
-- Version:   20260831210837
-- Generated: 2026-08-31T21:08:37Z by scripts/new-migration.sh
-- Branch:    feature/precruise-delivery-hardening
-- Worktree:  atc-precruise-2108
--
-- Record the material booking/contact context used to generate unsent cached
-- content, and prevent parallel consumers from both invoking the shared email
-- sender (and therefore duplicating local email logs and usage counters).
-- Claims older than the worker timeout may be reclaimed by application code;
-- Resend's deterministic idempotency key remains the delivery backstop.

ALTER TABLE public.pre_cruise_email_content
  ADD COLUMN content_context_fingerprint TEXT,
  ADD COLUMN send_claimed_at TIMESTAMPTZ;
