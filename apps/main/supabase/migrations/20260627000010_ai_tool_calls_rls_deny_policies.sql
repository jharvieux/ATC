-- §9.6 / §30.8 — Explicit deny policies for ai_tool_calls write paths.
--
-- The migration that created the table (20260627000009) added only a
-- SELECT policy (`auth_user_in_tenant(tenant_id)`) and granted
-- SELECT + INSERT to service_role. RLS was enabled but no policies
-- existed for INSERT/UPDATE/DELETE, so PostgreSQL's default
-- (deny-by-absence) handles them — service-role bypass means the
-- write path still works.
--
-- The §30.8 migration-lint rule wants explicit FALSE policies for
-- each write op anyway, so the table's RLS posture is readable
-- without inferring "no policy = deny". This migration adds them.
-- request_idempotency uses the same pattern.

CREATE POLICY ai_tool_calls_no_user_insert ON public.ai_tool_calls
  FOR INSERT WITH CHECK (FALSE);

CREATE POLICY ai_tool_calls_no_user_update ON public.ai_tool_calls
  FOR UPDATE USING (FALSE);

CREATE POLICY ai_tool_calls_no_user_delete ON public.ai_tool_calls
  FOR DELETE USING (FALSE);
