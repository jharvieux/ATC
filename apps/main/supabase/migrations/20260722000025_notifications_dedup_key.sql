-- Migration: notifications_dedup_key
-- Version:   20260722000025
-- Generated: 2026-07-16T20:12:00Z by scripts/new-migration.sh
-- Branch:    feature/sweep-privacy-1954
-- Worktree:  agent-af734c95a3fa68f6f
--
-- #1954 (D-091 #24 — DB uniqueness wherever app code assumes it).
--
-- The CCPA purge Inngest handler (user-data-purge-after-grace) writes one
-- in-app notification per active user in each affected tenant. On an Inngest
-- retry of a partially-completed run it re-inserts every notification it
-- already wrote, because `notifications` had no uniqueness for this shape —
-- tenant admins received duplicate CCPA notices.
--
-- Uniqueness key choice: a caller-supplied `dedup_key`, NOT
-- UNIQUE(tenant_id,user_id,category,title). The title is identical for every
-- CCPA purge, so a title-based key would wrongly collapse notifications about
-- two *different* purged customers into one, and would also constrain every
-- other notification category that happens to reuse a title. `dedup_key` is
-- opt-in (NULL for all existing callers) and namespaced by the caller
-- (`ccpa_purge:<purged_user_id>:<recipient_user_id>`), so it encodes exactly
-- "notify recipient R about purge P" and nothing else.
--
-- The index is PARTIAL (WHERE dedup_key IS NOT NULL): notifications is a
-- user-growing table and the overwhelming majority of rows leave dedup_key
-- NULL, so a partial index keeps it small. createNotification pairs this with
-- a 23505 handler for a genuinely idempotent insert.

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS dedup_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedup_key_uidx
  ON public.notifications (dedup_key)
  WHERE dedup_key IS NOT NULL;
