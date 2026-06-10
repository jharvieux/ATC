-- #908 — Member-level isolation for conversations + messages.
--
-- Before: both tables' policies were tenant-level only
-- (auth_user_in_tenant), so any authenticated member — and platform
-- customers ARE viewer-role members — could read/update any conversation
-- and transcript in their tenant through a JWT-driven client. The
-- production API routes use the service-role tenantClient proxy and were
-- guarded separately at the app layer (same PR); this migration is the
-- defense-in-depth DB layer so any future JWT path inherits the rule.
--
-- Access rule (docs/security/908-conversation-member-isolation.md):
--   owner (conversations.user_id = caller's public.users.id)
--   OR (staff role AND audience='customer').
-- TA threads (audience='tenant_member') stay own-only even for
-- tenant_owner, per D-195. Anonymous-owned rows (user_id IS NULL) fall
-- under the staff clause; anon visitors have no JWT and ride the
-- service-role path.

-- ---------------------------------------------------------------------------
-- auth_user_can_access_conversation(conv_id UUID, target_tenant_id UUID)
--
-- SECURITY DEFINER (§5.1.1: locked search_path, qualified refs, REVOKE
-- public / GRANT authenticated) so the messages policies can evaluate the
-- conversation predicate without recursive-RLS subqueries.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auth_user_can_access_conversation(
  conv_id UUID,
  target_tenant_id UUID
)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.conversations c
    WHERE c.id        = conv_id
      AND c.tenant_id = target_tenant_id
      AND (
        c.user_id = (
          SELECT u.id FROM public.users u
          WHERE u.auth_user_id = auth.uid()
            AND u.tenant_id    = target_tenant_id
            AND u.status       = 'active'
        )
        OR (
          c.audience = 'customer'
          AND EXISTS (
            SELECT 1 FROM public.users s
            WHERE s.auth_user_id = auth.uid()
              AND s.tenant_id    = target_tenant_id
              AND s.status       = 'active'
              AND s.role IN ('tenant_owner', 'agent')
          )
        )
      )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.auth_user_can_access_conversation(UUID, UUID) FROM public;
GRANT  EXECUTE ON FUNCTION public.auth_user_can_access_conversation(UUID, UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- conversations — tenant-level policies replaced with member-level.
-- INSERT additionally pins user_id to the caller: a JWT client can only
-- create threads it owns.
-- ---------------------------------------------------------------------------

DROP POLICY "conversations_select_policy" ON public.conversations;
DROP POLICY "conversations_insert_policy" ON public.conversations;
DROP POLICY "conversations_update_policy" ON public.conversations;
DROP POLICY "conversations_delete_policy" ON public.conversations;

CREATE POLICY "conversations_select_policy" ON public.conversations
  FOR SELECT TO PUBLIC
  USING (auth_user_can_access_conversation(id, tenant_id));

CREATE POLICY "conversations_insert_policy" ON public.conversations
  FOR INSERT TO PUBLIC
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
    -- NB: outer column must be table-qualified — bare tenant_id inside the
    -- subquery would bind to u.tenant_id (a tautology).
    AND user_id = (
      SELECT u.id FROM public.users u
      WHERE u.auth_user_id = auth.uid()
        AND u.tenant_id    = conversations.tenant_id
        AND u.status       = 'active'
    )
  );

CREATE POLICY "conversations_update_policy" ON public.conversations
  FOR UPDATE TO PUBLIC
  USING (auth_user_can_access_conversation(id, tenant_id))
  WITH CHECK (auth_user_can_access_conversation(id, tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY "conversations_delete_policy" ON public.conversations
  FOR DELETE TO PUBLIC
  USING (auth_user_can_access_conversation(id, tenant_id) AND tenant_is_active(tenant_id));

-- ---------------------------------------------------------------------------
-- messages — scoped through the parent conversation.
-- ---------------------------------------------------------------------------

DROP POLICY "messages_select_policy" ON public.messages;
DROP POLICY "messages_insert_policy" ON public.messages;
DROP POLICY "messages_update_policy" ON public.messages;
DROP POLICY "messages_delete_policy" ON public.messages;

CREATE POLICY "messages_select_policy" ON public.messages
  FOR SELECT TO PUBLIC
  USING (auth_user_can_access_conversation(conversation_id, tenant_id));

CREATE POLICY "messages_insert_policy" ON public.messages
  FOR INSERT TO PUBLIC
  WITH CHECK (auth_user_can_access_conversation(conversation_id, tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY "messages_update_policy" ON public.messages
  FOR UPDATE TO PUBLIC
  USING (auth_user_can_access_conversation(conversation_id, tenant_id))
  WITH CHECK (auth_user_can_access_conversation(conversation_id, tenant_id) AND tenant_is_active(tenant_id));

CREATE POLICY "messages_delete_policy" ON public.messages
  FOR DELETE TO PUBLIC
  USING (auth_user_can_access_conversation(conversation_id, tenant_id) AND tenant_is_active(tenant_id));
