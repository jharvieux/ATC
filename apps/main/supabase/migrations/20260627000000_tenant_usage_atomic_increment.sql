-- D-094 follow-up — atomic increment RPC for tenant_usage_metrics
--
-- Background: lib/ai/call-wrapper.ts:logAndIncrement was doing a
-- SELECT → INSERT/UPDATE round trip to increment ai_cost_cents per
-- (tenant_id, billing_period). That read-then-write pattern races
-- whenever two concurrent AI calls land in the same billing period
-- for the same tenant before either has written the first row —
-- the unique constraint on (tenant_id, billing_period) rejects the
-- second INSERT with 23505.
--
-- Pre-PR-#265: the rejection was silently swallowed (Pattern 1).
--   Result: ledger drifted by one call's worth of cost.
-- Post-PR-#265 with safeAwait: the rejection now propagates as a
--   SupabaseMutationError up through instrumentedClaudeCall, making
--   a successfully-completed AI call appear to FAIL to the caller —
--   the ai_call_log row has already committed, so any caller retry
--   would double-count.
--
-- Fix: do the increment atomically server-side with INSERT … ON CONFLICT
-- DO UPDATE SET ai_cost_cents = existing + incoming. No race, no surface.
--
-- Security: SECURITY DEFINER so the service-role caller has the right
-- to write the row even under RLS. Explicit search_path prevents
-- search-path-hijack attacks against the function's INSERT target.
-- The function name is namespaced and the caller (lib/ai/call-wrapper.ts)
-- is on the no-direct-service-role-import allowlist.

CREATE OR REPLACE FUNCTION public.increment_tenant_ai_cost(
  p_tenant_id      UUID,
  p_billing_period DATERANGE,
  p_amount_cents   BIGINT
)
RETURNS VOID
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.tenant_usage_metrics (tenant_id, billing_period, ai_cost_cents)
  VALUES (p_tenant_id, p_billing_period, p_amount_cents)
  ON CONFLICT (tenant_id, billing_period) DO UPDATE
    SET ai_cost_cents = public.tenant_usage_metrics.ai_cost_cents + EXCLUDED.ai_cost_cents;
$$;

-- service_role is the only caller; explicit revocation of anon/authenticated
-- prevents accidental exposure (no migration before this granted it).
REVOKE EXECUTE ON FUNCTION public.increment_tenant_ai_cost(UUID, DATERANGE, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_tenant_ai_cost(UUID, DATERANGE, BIGINT) TO service_role;

COMMENT ON FUNCTION public.increment_tenant_ai_cost(UUID, DATERANGE, BIGINT) IS
  'D-094: atomic increment of tenant_usage_metrics.ai_cost_cents. Replaces the read-then-write TOCTOU pattern in lib/ai/call-wrapper.ts:logAndIncrement.';
