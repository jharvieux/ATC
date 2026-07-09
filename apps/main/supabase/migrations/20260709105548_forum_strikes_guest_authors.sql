-- §19.9 — Guest (invitation-authored) strike-tracking + muting parity (#1572).
--
-- forum_strikes.user_id and forum_user_state.user_id are both NOT NULL, so a
-- guest who posts via an invite token (forum_messages.invitation_id, added by
-- 20260717000000_forum_guest_authors.sql) can never accrue a strike or be
-- muted — recordStrike/checkStrikePatterns have no invitation-author
-- equivalent to write to, even though the moderation pipeline itself already
-- hides their content correctly. Mirror the same author-XOR pattern used for
-- forum_messages/forum_threads.
--
-- Additive/expand-only: existing NOT NULL user_id columns become nullable,
-- new nullable FK columns are added, and a CHECK enforces exactly one author
-- reference per row. No POLICY/GRANT changes — forum_strikes and
-- forum_user_state are only ever written by service-role callers
-- (recordStrike/checkStrikePatterns/the coordinator mute route), so the
-- existing auth_user_in_tenant(tenant_id) RLS is unaffected by widening the
-- author column set.

ALTER TABLE public.forum_strikes
  ALTER COLUMN user_id DROP NOT NULL,
  ADD COLUMN invitation_id UUID REFERENCES public.invitations(id),
  ADD CONSTRAINT forum_strikes_author_xor CHECK (
    (user_id IS NOT NULL) <> (invitation_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS forum_strikes_invitation_created_idx
  ON public.forum_strikes(invitation_id, created_at)
  WHERE invitation_id IS NOT NULL;

ALTER TABLE public.forum_user_state
  ALTER COLUMN user_id DROP NOT NULL,
  ADD COLUMN invitation_id UUID REFERENCES public.invitations(id),
  ADD CONSTRAINT forum_user_state_author_xor CHECK (
    (user_id IS NOT NULL) <> (invitation_id IS NOT NULL)
  );

-- One state row per (forum, invitation) — mirrors the existing
-- UNIQUE (forum_id, user_id) for members; NULL invitation_id on member rows
-- doesn't collide (multi-column UNIQUE treats NULL as distinct).
CREATE UNIQUE INDEX IF NOT EXISTS forum_user_state_forum_invitation_uidx
  ON public.forum_user_state(forum_id, invitation_id)
  WHERE invitation_id IS NOT NULL;
