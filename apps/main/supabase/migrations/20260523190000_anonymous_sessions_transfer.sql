-- §11.6 anonymous_sessions: minimal stub + transfer lifecycle columns
-- anonymous_sessions does not exist yet from earlier auth work — creating
-- it here as a minimal stub for the transfer flow. The full auth-session
-- wiring (passkeys, device tokens, etc.) lands in a later prompt.

CREATE TABLE public.anonymous_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  last_active_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Transfer lifecycle columns per §11.6
ALTER TABLE public.anonymous_sessions
  ADD COLUMN transfer_soft_commit_at  TIMESTAMPTZ,
  ADD COLUMN transferred_to_user_id   UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN transfer_committed_at    TIMESTAMPTZ,
  ADD COLUMN transfer_undo_count      INTEGER NOT NULL DEFAULT 0;

-- Partial index for the 24-hour soft-commit window — used by the finalize
-- Inngest function to find sessions that are committed but not yet hard-committed.
CREATE INDEX anonymous_sessions_pending_commit_idx
  ON public.anonymous_sessions(transfer_soft_commit_at)
  WHERE transfer_soft_commit_at IS NOT NULL
    AND transfer_committed_at IS NULL;

-- RLS: tenant-scoped read/write for the transfer consent UI and undo banner.
ALTER TABLE public.anonymous_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY anonymous_sessions_tenant_select ON public.anonymous_sessions
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY anonymous_sessions_tenant_insert ON public.anonymous_sessions
  FOR INSERT TO authenticated
  WITH CHECK (auth_user_in_tenant(tenant_id));

CREATE POLICY anonymous_sessions_tenant_update ON public.anonymous_sessions
  FOR UPDATE TO authenticated
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (auth_user_in_tenant(tenant_id));

CREATE POLICY anonymous_sessions_tenant_delete ON public.anonymous_sessions
  FOR DELETE TO authenticated
  USING (auth_user_in_tenant(tenant_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.anonymous_sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.anonymous_sessions TO service_role;
