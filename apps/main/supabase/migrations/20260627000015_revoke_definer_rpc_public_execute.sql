-- Security advisor (lints 0028/0029) — main-project SECURITY DEFINER RPC exposure.
--
-- forum_messages_assert_one_level_reply() is a TRIGGER function. Triggers
-- fire via the trigger mechanism regardless of the caller's EXECUTE
-- privilege, so its GRANT to `authenticated` only exposes it as a pointless
-- /rest/v1/rpc target. Revoke that grant; the BEFORE INSERT/UPDATE trigger
-- on public.forum_messages keeps firing.
--
-- resolve_customer_chat_caps(uuid,uuid) is SECURITY DEFINER and resolves
-- caps across the (customer, tenant) boundary. Its only caller is
-- server-side via the service-role client (chat route ->
-- enforceCustomerLimit(svc, ...) -> resolveCaps), so the `authenticated`
-- grant is unused and would let a signed-in user probe another customer's
-- caps with arbitrary args. Revoke it; service_role keeps its grant.
--
-- NOT CHANGED (intentional, despite the advisor flag): auth_user_in_tenant(uuid)
-- and tenant_is_active(uuid) are RLS *helper* functions invoked inside the
-- tenant-isolation policy clauses across the schema. RLS evaluation for an
-- `authenticated` user requires that role to hold EXECUTE on them; revoking
-- would break tenant-isolation enforcement platform-wide. Their
-- `authenticated` grant is required and stays.

REVOKE EXECUTE ON FUNCTION public.forum_messages_assert_one_level_reply() FROM authenticated;

REVOKE EXECUTE ON FUNCTION public.resolve_customer_chat_caps(UUID, UUID) FROM authenticated;
