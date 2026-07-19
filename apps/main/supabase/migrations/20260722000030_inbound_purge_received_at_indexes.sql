-- Migration: inbound_purge_received_at_indexes (fix #2038 item 1)
-- Version:   20260722000030
-- Generated: 2026-07-19 by scripts/new-migration.sh
--
-- WHAT: add received_at indexes to the two inbound-email tables that the
--   retention sweeps scan.
--
-- WHY: the gmail_inbound_messages / inbound_emails retention purges filter
--   .lt(received_at, cutoff) with NO tenant predicate, but both tables only
--   index (tenant_id, received_at) — a composite whose leading column the
--   sweep never constrains, so the planner can't use it and the delete
--   degrades to a full scan as the tables grow. A plain (received_at) index
--   lets the cutoff sweep range-scan. Mirrors the auth_attempts_purge_idx
--   precedent (20260605000000_audit_log_and_security.sql).
--
-- RE-RUNNABLE: CREATE INDEX IF NOT EXISTS. No CONCURRENTLY (runbook rule 3 —
--   multi-statement pipeline errors 25001 on CONCURRENTLY). Index-only change,
--   no policy/grant delta → no snapshot regen (runbook rule 1). Suffix _idx per
--   the plain-index convention (runbook rule 8).

CREATE INDEX IF NOT EXISTS gmail_inbound_messages_purge_idx
  ON public.gmail_inbound_messages (received_at);

CREATE INDEX IF NOT EXISTS inbound_emails_purge_idx
  ON public.inbound_emails (received_at);
