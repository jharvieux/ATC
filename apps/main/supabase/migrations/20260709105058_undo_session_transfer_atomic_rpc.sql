-- Migration: undo_session_transfer_atomic_rpc
-- Version:   20260709105058
-- Generated: 2026-07-09T10:50:58Z by scripts/new-migration.sh
-- Branch:    feature/sweep-auth-1591
-- Worktree:  agent-aaa1b6ce7de41af37
--
-- §11.6 / #1703 audit (D-091 pattern 21/22) — atomic session-transfer undo.
--
-- The undo route did two dependent, non-atomic writes: (a) a CAS on
-- anonymous_sessions that cleared transfer_soft_commit_at + transferred_to_user_id
-- and bumped transfer_undo_count, then (b) a separate UPDATE reverting
-- conversations.user_id → NULL. If (b) failed after (a) committed, the session
-- read as "undone" while its conversations stayed user-owned, and retry was dead:
-- a re-POST reads transferred_to_user_id IS NULL → 403 not_owner before the
-- conversation revert can re-run. This RPC folds both writes into one
-- transaction: either the CAS wins AND conversations revert, or nothing changes.
--
-- The CAS guard (transfer_committed_at IS NULL AND transfer_soft_commit_at IS NOT
-- NULL AND transferred_to_user_id = p_user_id) matches the pre-checks in the
-- route; zero session rows updated means the finalize cron won the race between
-- the route's pre-check read and this call, so the conversation revert is skipped
-- and the route maps the 0 return → 409. Tenant-scoped on both writes (§ two-layer
-- isolation).
--
-- SECURITY DEFINER with an empty search_path (every object schema-qualified) so
-- the service-role caller (app/api/auth/transfer-session/undo/route.ts) runs it
-- under RLS; EXECUTE revoked from PUBLIC and granted only to service_role.

CREATE OR REPLACE FUNCTION public.undo_session_transfer(
  p_session_id UUID,
  p_tenant_id  UUID,
  p_user_id    UUID
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  -- CAS: clear the soft-commit state only while still reversible and owned by
  -- the caller. transfer_undo_count is bumped in the same statement.
  UPDATE public.anonymous_sessions
  SET    transfer_soft_commit_at = NULL,
         transferred_to_user_id  = NULL,
         transfer_undo_count     = transfer_undo_count + 1
  WHERE  id                      = p_session_id
    AND  tenant_id               = p_tenant_id
    AND  transfer_committed_at   IS NULL
    AND  transfer_soft_commit_at IS NOT NULL
    AND  transferred_to_user_id  = p_user_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Lost the race with the finalize cron (or never eligible): revert nothing.
  IF v_count = 0 THEN
    RETURN 0;
  END IF;

  -- Revert the conversation re-keying softCommitTransfer applied. Messages
  -- carry no user_id (ownership follows the conversation), so re-nulling
  -- conversations.user_id is the only revert needed.
  UPDATE public.conversations
  SET    user_id = NULL
  WHERE  anonymous_session_id = p_session_id
    AND  tenant_id            = p_tenant_id;

  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.undo_session_transfer(UUID, UUID, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.undo_session_transfer(UUID, UUID, UUID) TO service_role;

COMMENT ON FUNCTION public.undo_session_transfer(UUID, UUID, UUID) IS
  '#1703: atomically CAS-clears an anonymous_sessions soft-commit transfer and reverts its conversations.user_id → NULL in one transaction. Returns the number of session rows updated (0 = lost race → caller returns 409).';
