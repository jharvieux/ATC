-- The anonymous (invite-token) forum write endpoints (thread creation +
-- message posting) have no session/role gate, so a leaked or shared invite
-- link could otherwise drive unbounded paid Haiku moderation calls. Mirrors
-- the anonymous_chat_counters / increment_anon_chat_counter pattern
-- (20260603000000_chat_ui.sql, 20260709000000_atomic_chat_limit_counters.sql):
-- atomic consume-then-check RPC, service-role only, rolling window folded
-- into the same statement.

CREATE TABLE public.forum_guest_write_counters (
  invitation_id     UUID        NOT NULL REFERENCES public.invitations(id) ON DELETE CASCADE,
  tenant_id         UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  current_count     INTEGER     NOT NULL DEFAULT 0,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (invitation_id)
);

ALTER TABLE public.forum_guest_write_counters ENABLE ROW LEVEL SECURITY;

-- Read/written by service_role only, via the RPC below — no end-user
-- visibility, same shape as anonymous_chat_counters.
CREATE POLICY forum_guest_write_counters_select_service ON public.forum_guest_write_counters
  FOR SELECT USING (FALSE);
CREATE POLICY forum_guest_write_counters_insert_service ON public.forum_guest_write_counters
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY forum_guest_write_counters_update_service ON public.forum_guest_write_counters
  FOR UPDATE USING (FALSE);
CREATE POLICY forum_guest_write_counters_delete_service ON public.forum_guest_write_counters
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.forum_guest_write_counters TO service_role;

CREATE OR REPLACE FUNCTION public.increment_forum_guest_write_counter(
  p_invitation_id  UUID,
  p_tenant_id      UUID,
  p_window_seconds INTEGER
)
RETURNS INTEGER
LANGUAGE SQL
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO public.forum_guest_write_counters
    (invitation_id, tenant_id, current_count, window_started_at)
  VALUES (p_invitation_id, p_tenant_id, 1, NOW())
  ON CONFLICT (invitation_id) DO UPDATE
    SET current_count = CASE
          WHEN public.forum_guest_write_counters.window_started_at
               < NOW() - make_interval(secs => p_window_seconds)
          THEN 1
          ELSE public.forum_guest_write_counters.current_count + 1
        END,
        window_started_at = CASE
          WHEN public.forum_guest_write_counters.window_started_at
               < NOW() - make_interval(secs => p_window_seconds)
          THEN NOW()
          ELSE public.forum_guest_write_counters.window_started_at
        END
  RETURNING current_count;
$$;

REVOKE EXECUTE ON FUNCTION public.increment_forum_guest_write_counter(UUID, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_forum_guest_write_counter(UUID, UUID, INTEGER) TO service_role;

COMMENT ON FUNCTION public.increment_forum_guest_write_counter(UUID, UUID, INTEGER) IS
  'Atomic consume-then-check increment of forum_guest_write_counters.current_count with rolling-window reset. Returns the post-increment count.';
