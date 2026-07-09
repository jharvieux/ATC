-- Migration: forum_user_state_invitation_full_unique
-- Version:   20260709111701
-- Generated: 2026-07-09T11:17:01Z by scripts/new-migration.sh
-- Branch:    feature/sweep-community-1476
--
-- Replace the guest (forum, invitation) uniqueness enforcement from a PARTIAL
-- unique INDEX with a FULL table UNIQUE CONSTRAINT.
--
-- Why: 20260709105548_forum_strikes_guest_authors.sql created
-- forum_user_state_forum_invitation_uidx as a PARTIAL index
-- (WHERE invitation_id IS NOT NULL). The guest auto-mute path in
-- apps/main/src/lib/forums/strikes.ts upserts with
-- onConflict: "forum_id,invitation_id", and PostgREST emits NO predicate on
-- ON CONFLICT — so Postgres cannot match the arbiter to a partial index and
-- raises 42P10 ("there is no unique or exclusion constraint matching the ON
-- CONFLICT specification"). The guest upsert then fails at runtime and the
-- guest is never muted. A full (non-partial) UNIQUE constraint IS a valid
-- inference arbiter for a predicate-less ON CONFLICT. Member rows stay safe
-- because a multi-column UNIQUE treats NULL invitation_id as distinct, so
-- member rows (invitation_id IS NULL) never collide with each other.
--
-- Not editable in place: 20260709105548 is already recorded on the shared
-- test-DB ledger, so per docs/runbooks/migrations.md this ships as a NEW
-- forward migration (drop the partial index, add the full constraint) rather
-- than a rewrite of the recorded one.
--
-- No POLICY/GRANT changes — forum_user_state's auth_user_in_tenant(tenant_id)
-- RLS is unaffected; a constraint is neither a policy nor a grant, so no
-- rls/grants snapshot regeneration is required.

DROP INDEX IF EXISTS forum_user_state_forum_invitation_uidx;

ALTER TABLE public.forum_user_state
  ADD CONSTRAINT forum_user_state_forum_invitation_key UNIQUE (forum_id, invitation_id);
