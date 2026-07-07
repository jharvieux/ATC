-- #1600 — one active invitation per (group, email). The single-invite
-- endpoint had no dedup guard, so the same address could be invited to a
-- group repeatedly. Partial (WHERE token_revoked_at IS NULL) so historical
-- revoked rows, and the reissue_all flow (revoke old rows, insert fresh
-- ones), never collide with this index.

-- Dedupe existing active duplicates first, keeping the earliest row per
-- (group_id, lower(invitee_email)) so the index below can be created.
DELETE FROM public.invitations t
WHERE t.token_revoked_at IS NULL
  AND t.id NOT IN (
    SELECT DISTINCT ON (group_id, lower(invitee_email)) id
    FROM public.invitations
    WHERE token_revoked_at IS NULL
    ORDER BY group_id, lower(invitee_email), created_at ASC, id ASC
  );

CREATE UNIQUE INDEX IF NOT EXISTS invitations_group_active_email_uniq_idx
  ON public.invitations (group_id, lower(invitee_email))
  WHERE token_revoked_at IS NULL;
