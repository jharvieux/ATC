-- Migration: users_auth_user_created_idx
-- Version:   20260722000011
-- Generated: 2026-07-09 by scripts/new-migration.sh
-- Branch:    feature/sweep-db-misc-1698
-- Worktree:  agent-a79f0cb75f2288c77
--
-- #1714 (#1588/#1701 follow-up) — covering index for the legal-docs re-consent
-- email lookup (apps/main/src/app/api/admin/legal-docs/route.ts). That route
-- looks up users via `.in(auth_user_id, [...])` and orders `created_at` ASC to
-- deterministically pick the oldest row's email per user. No `id` tiebreaker is
-- needed here — this is a canonical-pick order, not a pagination tiebreaker.
-- The existing UNIQUE (tenant_id, auth_user_id) constraint leads with
-- tenant_id, so it doesn't serve an auth_user_id-only IN filter well.
--
-- Plain CREATE INDEX (no CONCURRENTLY — forbidden in the multi-statement
-- `supabase db push` pipeline, SQLSTATE 25001).

CREATE INDEX IF NOT EXISTS users_auth_user_created_idx
  ON public.users (auth_user_id, created_at);
