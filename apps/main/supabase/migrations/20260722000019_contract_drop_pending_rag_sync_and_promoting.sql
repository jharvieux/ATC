-- Migration: contract_drop_pending_rag_sync_and_promoting
-- Version:   20260722000019
-- Generated: 2026-07-13T01:52:59Z by scripts/new-migration.sh
-- Branch:    feature/sweep-contract-migrations-1754
-- Worktree:  agent-a5691cb96a24f7220
--
-- Contract-phase cleanup (expand→switch→contract, anti-pattern 13 / #137).
-- Bundles four deferred schema items whose switch-over PRs are all merged and
-- live on beta, so the destructive statements ship here in their own PR:
--   #1825.1 — drop orphaned pending_rag_sync (switch: #1819 moved RAG-sync
--             delivery to Inngest; nothing writes/reads the table anymore)
--   #1825.2 — add the covering index #1817 omitted for email_log.retry_of
--   #1825.3 — correct migration ...017's stale 'daily' purge wording (hourly)
--   #1754   — drop orphaned 'promoting' from import_queue_status_check (switch:
--             #1712's promote_import RPC removed the last writer AND healed
--             stranded rows in 20260722000006)
-- Destructive statements carry idempotent guards (IF EXISTS / constraint swap)
-- per docs/runbooks/migrations.md.

-- ── #1825.1: drop orphaned pending_rag_sync ──────────────────────────────────
-- PR #1819 moved RAG tenant-event delivery off the in-request retry sleeps +
-- the pending_rag_sync retry cron + daily cleanup onto Inngest (rag-sync-deliver).
-- Grep of the current dev tree confirms zero writers/readers: only doc-comments
-- and the retirement test reference the name; no `.from('pending_rag_sync')`,
-- insert/update/delete exists. Any pre-deploy undelivered rows are healed by the
-- nightly RAG reconcile (§8.3 / platform-settings-reconcile). DROP IF EXISTS is
-- the idempotent guard; dropping the table removes its RLS + service_role grant.
DROP TABLE IF EXISTS public.pending_rag_sync;

-- ── #1825.2: covering index for the email_log.retry_of self-FK ───────────────
-- PR #1817 (20260722000017) added email_log.retry_of REFERENCES email_log(id)
-- without a covering index (d091 advisory). Only bulk email_log deletes probe it
-- (FK back-reference lookup); a partial index over non-null rows (the §23.7
-- re-send rows) is the minimal cover. NOT CONCURRENTLY — the runbook forbids it
-- in a multi-statement migration (supabase db push runs one pipeline; SQLSTATE
-- 25001). The brief lock on this table is negligible.
CREATE INDEX IF NOT EXISTS email_log_retry_of_idx
  ON public.email_log (retry_of)
  WHERE retry_of IS NOT NULL;

-- ── #1825.3: correct the record — email_retry_content purge is HOURLY ─────────
-- Migration 20260722000017 has two SQL comments calling the email_retry_content
-- purge cron 'daily'; it is hourly (email-retry-content-purge, cron '23 * * * *').
-- The applied file stays byte-untouched (ledger discipline); state the truth in
-- the live catalog via COMMENT ON so the schema is self-describing.
COMMENT ON TABLE public.email_retry_content IS
  '§23.7 soft-bounce retry payloads (rendered HTML = PII, service-role only). An HOURLY purge cron (email-retry-content-purge, cron ''23 * * * *'') deletes rows past expires_at. TTL is 7 days from send.';
COMMENT ON COLUMN public.email_retry_content.expires_at IS
  'Purge horizon (PII retention) — the HOURLY email-retry-content-purge cron (''23 * * * *'') deletes rows past this. 7 days from send.';

-- ── #1754: remove orphaned 'promoting' from import_queue_status_check ─────────
-- The promote_import atomic RPC (#1712, 20260722000006) removed the last writer
-- of status 'promoting' and, at cutover, healed any stranded row
-- (UPDATE import_queue SET status='pending_review' WHERE status='promoting'), so
-- no live row holds 'promoting' — the drop+recreate validates cleanly against
-- current data. Grep of the current dev tree confirms no writer/reader of the
-- 'promoting' literal remains (only a doc-comment in lib/import/promote.ts). The
-- constraint swap (DROP IF EXISTS + ADD) is idempotent per the runbook.
ALTER TABLE public.import_queue DROP CONSTRAINT IF EXISTS import_queue_status_check;
ALTER TABLE public.import_queue ADD CONSTRAINT import_queue_status_check CHECK (status IN (
  'pending_virus_scan',
  'virus_detected',
  'pending_classification',
  'pending_extraction',
  'pending_validation',
  'pending_review',
  'auto_accepted',
  'accepted',
  'rejected',
  'parse_failed'
));
