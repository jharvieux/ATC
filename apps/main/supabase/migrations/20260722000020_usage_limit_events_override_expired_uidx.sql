-- Migration: usage_limit_events_override_expired_uidx
-- Version:   20260722000020
-- Generated: 2026-07-13T11:33:53Z by scripts/new-migration.sh
-- Branch:    feature/sweep-db-1844
-- Worktree:  agent-sweep-db-1844
--
-- #1844 (D-091 #24) — back the abuse-override-expiry-sweep's audit dedup with
-- a real DB uniqueness guarantee. The sweep records one usage_limit_events row
-- per expired override, keyed by resolution_action = 'override_expired:<id>'.
-- Since #1830 it deduped via SELECT-then-INSERT, which survives a sequential
-- crash-then-retry but not a true concurrent double-invocation (TOCTOU).
--
-- The index is PARTIAL, scoped to the sweep's key namespace: other writers
-- reuse constant resolution_action values (threshold-recompute inserts
-- 'subscription_change_recompute' on every subscription change), so a plain
-- UNIQUE — or even one scoped to non-null — would break them. Only the
-- 'override_expired:%' namespace carries a per-row-unique key.
--
-- Expand-only, additive. No CONCURRENTLY (migrations runbook §3 — supabase db
-- push pipelines the file's statements, where CONCURRENTLY errors 25001; the
-- table is small so the brief lock is negligible). No policy or grant is
-- touched, so no RLS/grants snapshot regen is required.

-- Dedupe first: duplicates can only exist from a concurrent double-invocation
-- of the sweep (both rows describe the same override expiry — pure audit
-- noise, no money attached), so keeping the earliest row per key is safe and
-- lets the index build succeed instead of failing 23505 at prod-apply time.
DELETE FROM public.usage_limit_events e
WHERE e.resolution_action LIKE 'override_expired:%'
  AND e.id NOT IN (
    SELECT DISTINCT ON (resolution_action) id
    FROM public.usage_limit_events
    WHERE resolution_action LIKE 'override_expired:%'
    ORDER BY resolution_action, triggered_at ASC, id ASC
  );

CREATE UNIQUE INDEX IF NOT EXISTS usage_limit_events_override_expired_uidx
  ON public.usage_limit_events (resolution_action)
  WHERE resolution_action LIKE 'override_expired:%';
