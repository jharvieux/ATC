-- Migration: clarify_email_provider_dispatch_retention
-- Version:   20260901074338
-- Generated: 2026-09-01T07:43:38Z by scripts/new-migration.sh
-- Branch:    feature/precruise-delivery-hardening
-- Worktree:  atc-precruise-2108
--
-- Clarify that the 23-hour timestamp ends replay eligibility and makes queued
-- provider PII eligible for the bounded hourly purge; it does not guarantee
-- physical clearing at the exact cutoff. Comment-only; no rollback required.

COMMENT ON TABLE public.email_provider_dispatch IS
  'Service-role-only transient provider outbox. Exact rendered request and retry snapshot become purge-eligible when the 23-hour provider replay window closes.';

COMMENT ON COLUMN public.email_provider_dispatch.provider_request_body IS
  'Exact serialized Resend request body; customer PII; cleared on finalization or by the bounded hourly purge after the 23-hour replay window.';
