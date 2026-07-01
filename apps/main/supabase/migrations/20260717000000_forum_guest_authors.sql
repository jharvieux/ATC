-- §19.x — Anonymous invitee forum authorship (group-landing redesign, PR6).
--
-- Guests who hold only an HMAC-signed invite token (apps/main/src/app/api/
-- groups/invite/[token]/forum/**) have no public.users row — invitations are
-- keyed by invitee_email, not by an authenticated user. forum_threads and
-- forum_messages both assumed every author was an authenticated user
-- (created_by_user_id / user_id NOT NULL). This adds an alternate,
-- mutually-exclusive author reference to public.invitations so guest-authored
-- threads/messages can be attributed and rendered (display name derived the
-- same way as the roster — see apps/main/src/lib/groups/roster.ts +
-- apps/main/src/lib/groups/visibility.ts) without requiring a users row.
--
-- Additive/expand-only: the existing NOT NULL author columns become
-- nullable, new nullable FK columns are added, and a CHECK enforces "exactly
-- one author reference set" (XOR) so every row still has exactly one
-- identifiable author. No POLICY/GRANT changes — the new guest-facing routes
-- are public, HMAC-token-gated, service-role (RLS-bypassing) endpoints, same
-- pattern as the existing RSVP/invite-token routes, so no new RLS surface is
-- introduced here.

ALTER TABLE public.forum_threads
  ALTER COLUMN created_by_user_id DROP NOT NULL,
  ADD COLUMN created_by_invitation_id UUID REFERENCES public.invitations(id),
  ADD CONSTRAINT forum_threads_author_xor CHECK (
    (created_by_user_id IS NOT NULL) <> (created_by_invitation_id IS NOT NULL)
  );

ALTER TABLE public.forum_messages
  ALTER COLUMN user_id DROP NOT NULL,
  ADD COLUMN invitation_id UUID REFERENCES public.invitations(id),
  ADD CONSTRAINT forum_messages_author_xor CHECK (
    (user_id IS NOT NULL) <> (invitation_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS forum_threads_created_by_invitation_id_idx
  ON public.forum_threads(created_by_invitation_id)
  WHERE created_by_invitation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS forum_messages_invitation_id_idx
  ON public.forum_messages(invitation_id)
  WHERE invitation_id IS NOT NULL;
