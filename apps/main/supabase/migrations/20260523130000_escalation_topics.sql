-- §10.3 Topic-Level Escalation
--
-- Escalation is tracked at the TOPIC level, not the conversation level.
-- A customer may have an active escalation about a refund while continuing
-- to chat with AI about an unrelated future trip.
--
-- RLS: full four-policy set (tenant-scoped per §5.1.2).

CREATE TABLE public.escalation_topics (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES public.tenants(id),
  conversation_id     UUID        NOT NULL REFERENCES public.conversations(id),
  user_id             UUID        REFERENCES public.users(id),
  topic_summary       TEXT        NOT NULL,
  topic_tags          TEXT[],
  status              TEXT        NOT NULL CHECK (status IN ('open','in_progress','resolved','closed')),
  initiated_by        TEXT,       -- 'supervisor' | 'customer' | 'agent'
  initiated_reason    TEXT,
  assigned_agent_id   UUID        REFERENCES public.users(id),
  opened_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at         TIMESTAMPTZ,
  resolution_notes    TEXT
);

CREATE INDEX escalation_topics_tenant_status_idx
  ON public.escalation_topics(tenant_id, status);

CREATE INDEX escalation_topics_conversation_idx
  ON public.escalation_topics(conversation_id);

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.escalation_topics ENABLE ROW LEVEL SECURITY;

CREATE POLICY escalation_topics_select_policy ON public.escalation_topics
  FOR SELECT
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY escalation_topics_insert_policy ON public.escalation_topics
  FOR INSERT
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY escalation_topics_update_policy ON public.escalation_topics
  FOR UPDATE
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY escalation_topics_delete_policy ON public.escalation_topics
  FOR DELETE
  USING (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

-- ── Grants ──────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.escalation_topics TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.escalation_topics TO service_role;
