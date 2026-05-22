-- §10.6 AI Kill Switch
--
-- Single-row table (enforced by CHECK id = 1) that tracks the global AI
-- pause state. The supervisor reads this on every chat turn (cache TTL ≤ 30s).
--
-- Per-tenant pause uses tenants.status = 'suspended' — the existing
-- suspension mechanism already cuts off customer-facing chat. No new
-- column is needed for per-tenant pause.
--
-- RLS:
--   SELECT: any authenticated user — the chat path needs this on every turn.
--   INSERT/UPDATE: blocked for authenticated; only via service_role
--     (withPlatformAdminAudit kill-switch route). RLS implicitly blocks
--     authenticated writes since no INSERT/UPDATE policy is defined.

CREATE TABLE public.ai_kill_switch_state (
  id                      INT         PRIMARY KEY CHECK (id = 1),
  global_paused           BOOLEAN     NOT NULL DEFAULT FALSE,
  global_paused_at        TIMESTAMPTZ,
  global_paused_by_user_id UUID       REFERENCES public.users(id),
  global_paused_reason    TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the single row
INSERT INTO public.ai_kill_switch_state (id) VALUES (1);

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.ai_kill_switch_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_kill_switch_state_select_policy ON public.ai_kill_switch_state
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- No INSERT/UPDATE/DELETE policies for authenticated — writes go through
-- service_role (withPlatformAdminAudit) which bypasses RLS.

-- ── Grants ──────────────────────────────────────────────────────────────────

GRANT SELECT ON public.ai_kill_switch_state TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_kill_switch_state TO service_role;
