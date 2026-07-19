-- Migration: gmail_inbound_deny_policies
-- Version:   20260722000028
-- Generated: 2026-07-19T20:22:00Z by scripts/new-migration.sh
-- Branch:    feature/pii-retention-2031
-- Worktree:  agent-a42324f0aa46c4d54
--
-- #2031 (§30.8) — explicit deny policies for INSERT/UPDATE/DELETE on
-- gmail_inbound_messages. The table shipped (20260617000000_bp34_phase_c_gmail_storage)
-- with only a SELECT policy for `authenticated` and no write policies, relying
-- on grant-absence to block writes. §30.8's convention (and the sibling
-- inbound_emails table) is an EXPLICIT WITH CHECK (FALSE) / USING (FALSE) deny
-- per write verb, so RLS itself — not just the missing GRANT — denies the write
-- and the intent is legible in the policy catalog. service_role bypasses RLS and
-- keeps its writes (the Pub/Sub ingest path). Expand-only; policy add, no data.

CREATE POLICY gmail_inbound_insert_service ON public.gmail_inbound_messages
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY gmail_inbound_update_service ON public.gmail_inbound_messages
  FOR UPDATE USING (FALSE);
CREATE POLICY gmail_inbound_delete_service ON public.gmail_inbound_messages
  FOR DELETE USING (FALSE);
