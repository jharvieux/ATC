-- Migration: usage_limit_events_rollover_uidx
-- Version:   20260722000027
-- Generated: 2026-07-17T02:01:21Z by scripts/new-migration.sh
-- Branch:    feature/sweep-billing-1901
-- Worktree:  agent-aca934852f4b2185e
--
-- #1901 (D-091 #24 / #23) — back the billing-period-rollover audit dedup with
-- a real DB uniqueness guarantee. The rollover records one usage_limit_events
-- row per (tenant, billing_period, dimension), now keyed by
-- resolution_action = 'rollover:<tenant_id>:<billing_period>:<dimension>'.
-- Before this, those 4 audit inserts per tenant had NO dedup guard, so every
-- Inngest retry / duplicate cron fire of the same period re-inserted a fresh
-- set of audit rows even though the tenant_usage_metrics counter row (which
-- IS ON CONFLICT DO NOTHING) stayed byte-for-byte the same — inflating the
-- audit trail admins read to explain a tenant's usage history.
--
-- The index is PARTIAL, scoped to the rollover key namespace ('rollover:%').
-- Other writers reuse constant resolution_action values (the override sweep
-- uses 'override_expired:<id>', threshold recompute uses
-- 'subscription_change_recompute'), so a plain UNIQUE — or one merely scoped
-- to non-null — would break them. Only the 'rollover:%' namespace carries a
-- per-row-unique key. This mirrors usage_limit_events_override_expired_uidx
-- (#1844).
--
-- No dedup DELETE precedes the index build: the 'rollover:%' resolution_action
-- namespace is net-new (the pre-fix rollover inserts left resolution_action
-- NULL), so no existing row can match the partial predicate and the unique
-- build cannot fail 23505 on historical data. Pre-fix rollover audit rows keep
-- their NULL key and are untouched.
--
-- Expand-only, additive. No CONCURRENTLY (migrations runbook §3 — supabase db
-- push pipelines the file's statements, where CONCURRENTLY errors 25001; the
-- table is small so the brief lock is negligible). No policy or grant is
-- touched, so no RLS/grants snapshot regen is required.

CREATE UNIQUE INDEX IF NOT EXISTS usage_limit_events_rollover_uidx
  ON public.usage_limit_events (resolution_action)
  WHERE resolution_action LIKE 'rollover:%';
