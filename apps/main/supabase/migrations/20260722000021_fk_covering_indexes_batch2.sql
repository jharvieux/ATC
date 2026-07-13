-- Migration: fk_covering_indexes_batch2
-- Version:   20260722000021
-- Generated: 2026-07-13T11:42:53Z by scripts/new-migration.sh
-- Branch:    feature/sweep-db-1782
-- Worktree:  agent-a3841310100aa7f38
--
-- Covering indexes for the 4 unindexed foreign keys the Supabase performance
-- advisor flagged in #1782 (unindexed_foreign_keys). These are the tail of the
-- set 20260714000000_fk_covering_indexes.sql (#1483) fixed — those 4 columns
-- were either added after that migration (forum_user_state.invitation_id,
-- forum_guest_write_counters.tenant_id) or otherwise missed. Without a covering
-- index on the child column, a parent UPDATE/DELETE and any JOIN on the FK
-- forces a sequential scan on the child table. Each index is purely additive —
-- no query behavior changes.
--
-- FK sources verified against live pg_constraint definitions (migrations.md
-- rule 5 — advisor column numbers can be stale):
--   forum_guest_write_counters.tenant_id      -> tenants(id)   (PK is invitation_id; tenant_id uncovered)
--   forum_user_state.invitation_id            -> invitations(id) (only composite UNIQUE(forum_id, invitation_id); invitation_id not leading)
--   inbound_emails.contact_id                 -> contacts(id)
--   inbound_emails.forwarded_email_log_id     -> email_log(id)
--
-- Plain CREATE INDEX (not CONCURRENTLY): `supabase db push` runs a migration's
-- statements in a single pipeline, where CONCURRENTLY errors SQLSTATE 25001
-- (migrations.md rule 3). The brief ACCESS SHARE build lock is negligible on
-- these small tables.
--
-- Plain additive indexes touch no policy or grant, so no rls/grants snapshot
-- regeneration is required.

CREATE INDEX IF NOT EXISTS forum_guest_write_counters_tenant_id_idx ON public.forum_guest_write_counters (tenant_id);
CREATE INDEX IF NOT EXISTS forum_user_state_invitation_id_idx ON public.forum_user_state (invitation_id);
CREATE INDEX IF NOT EXISTS inbound_emails_contact_id_idx ON public.inbound_emails (contact_id);
CREATE INDEX IF NOT EXISTS inbound_emails_forwarded_email_log_id_idx ON public.inbound_emails (forwarded_email_log_id);
