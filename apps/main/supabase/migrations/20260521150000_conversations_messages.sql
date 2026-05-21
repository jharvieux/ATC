-- §5.2 Conversations & Messages
--
-- RLS pattern: read-only-after-suspension (§5.1.2 deviation note).
-- SELECT allows suspended-tenant users to read historical conversations/messages.
-- INSERT/UPDATE/DELETE require tenant_is_active.

CREATE TABLE public.conversations (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID        NOT NULL REFERENCES public.tenants(id),
  user_id              UUID        REFERENCES public.users(id),
  anonymous_session_id UUID,
  -- TODO(contacts-fk): add FK REFERENCES public.contacts(id) when contacts table lands
  contact_id           UUID,
  -- TODO(personas-fk): add FK REFERENCES public.personas(id) when personas table lands
  active_persona_id    UUID,
  title                TEXT,
  status               TEXT        NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','escalated','closed','archived')),
  summary              TEXT,
  summary_updated_at   TIMESTAMPTZ,
  first_message_at     TIMESTAMPTZ,
  last_message_at      TIMESTAMPTZ,
  message_count        INTEGER     NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.messages (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES public.tenants(id),
  conversation_id     UUID        NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  role                TEXT        NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content             TEXT        NOT NULL,
  -- TODO(personas-fk): add FK REFERENCES public.personas(id) when personas table lands
  persona_id          UUID,
  tool_calls          JSONB,
  rag_chunks_used     JSONB,
  supervisor_findings JSONB,
  feedback_score      INTEGER     CHECK (feedback_score IN (-1, 0, 1)),
  feedback_reason     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX messages_conversation_idx ON public.messages(conversation_id, created_at);
CREATE INDEX conversations_tenant_user_idx ON public.conversations(tenant_id, user_id);

-- ── RLS: conversations ──────────────────────────────────────────────────────

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY conversations_select_policy ON public.conversations
  FOR SELECT
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY conversations_insert_policy ON public.conversations
  FOR INSERT
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY conversations_update_policy ON public.conversations
  FOR UPDATE
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY conversations_delete_policy ON public.conversations
  FOR DELETE
  USING (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

-- ── RLS: messages ───────────────────────────────────────────────────────────

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY messages_select_policy ON public.messages
  FOR SELECT
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY messages_insert_policy ON public.messages
  FOR INSERT
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY messages_update_policy ON public.messages
  FOR UPDATE
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY messages_delete_policy ON public.messages
  FOR DELETE
  USING (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

-- ── Grants ──────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO service_role;
