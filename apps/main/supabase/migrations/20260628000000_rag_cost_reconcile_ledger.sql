-- Issue #692 — Nightly reconciliation of RAG embedding cost into
-- tenant_usage_metrics on this DB.
--
-- Background: lib/embeddings/cost-log.ts writes one rag_ai_call_log row
-- per embedding call on the RAG DB. The dashboard merges these into the
-- platform-admin Resource Utilization view, but the enforcement layer
-- (tenant_usage_metrics.ai_cost_cents → soft1 → soft2 → hard limit state
-- machine) on this DB doesn't see embedding spend at all. A tenant who
-- ingests heavily through approve/tenant or replace-chunk would never
-- trip their AI cost limit from embedding alone.
--
-- This migration adds the consumer-side dedup ledger that lets a nightly
-- Inngest cron reconcile rag rows into tenant_usage_metrics exactly once
-- per row, even across overlapping cron windows or retry storms.
--
-- Why a ledger and not just a watermark:
-- A watermark (last_reconciled_at) makes the whole run atomic — partial
-- success on a multi-tenant batch followed by a retry would double-count
-- whichever tenants were processed before the failure. Per-row dedup
-- removes that footgun: each rag_log_id is counted exactly once, ever.

-- 1. Ledger table — one row per reconciled rag_ai_call_log row.
CREATE TABLE public.rag_cost_reconcile_ledger (
  rag_log_id      UUID        PRIMARY KEY,
  tenant_id       UUID        NOT NULL,
  billing_period  DATERANGE   NOT NULL,
  amount_cents    BIGINT      NOT NULL,
  reconciled_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cleanup index: lets a future TTL job drop rows older than ~2 billing
-- periods without a full scan. The ledger only needs to retain rows long
-- enough that the cron's lookback window can't possibly re-process them.
CREATE INDEX rag_cost_reconcile_ledger_reconciled_idx
  ON public.rag_cost_reconcile_ledger(reconciled_at);

ALTER TABLE public.rag_cost_reconcile_ledger ENABLE ROW LEVEL SECURITY;

-- Authenticated users have no business touching this table — it's strictly
-- internal reconciler state. Service-role bypass + explicit per-action
-- deny policies (the §30.8 lint gate requires one policy per action even
-- on service-role-only tables). The reconciler is the only writer; the
-- platform-admin dashboard reads ai_cost from tenant_usage_metrics, not
-- from this ledger.
CREATE POLICY rag_cost_reconcile_ledger_no_user_select ON public.rag_cost_reconcile_ledger
  FOR SELECT USING (FALSE);
CREATE POLICY rag_cost_reconcile_ledger_no_user_insert ON public.rag_cost_reconcile_ledger
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY rag_cost_reconcile_ledger_no_user_update ON public.rag_cost_reconcile_ledger
  FOR UPDATE USING (FALSE);
CREATE POLICY rag_cost_reconcile_ledger_no_user_delete ON public.rag_cost_reconcile_ledger
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.rag_cost_reconcile_ledger TO service_role;

-- 2. Atomic dedup-and-increment RPC.
--
-- Single-TX semantics matter: if the ledger INSERT succeeded but the
-- increment failed (or vice-versa), the next cron firing would either
-- double-count or never count. Wrapping both in one PL/pgSQL function
-- ties them to the same transaction, so any failure rolls back both
-- writes and the next run sees the row as un-reconciled.
--
-- Returns BOOLEAN: TRUE iff this call newly counted the row (the caller
-- uses it for a "suspended" count in the run summary). FALSE means the
-- row was already in the ledger from a prior run — common during the
-- overlap window between consecutive cron firings.
CREATE OR REPLACE FUNCTION public.reconcile_rag_cost_row(
  p_rag_log_id      UUID,
  p_tenant_id       UUID,
  p_billing_period  DATERANGE,
  p_amount_cents    BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row_count INTEGER;
BEGIN
  INSERT INTO public.rag_cost_reconcile_ledger (rag_log_id, tenant_id, billing_period, amount_cents)
  VALUES (p_rag_log_id, p_tenant_id, p_billing_period, p_amount_cents)
  ON CONFLICT (rag_log_id) DO NOTHING;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;

  IF v_row_count = 1 THEN
    PERFORM public.increment_tenant_ai_cost(p_tenant_id, p_billing_period, p_amount_cents);
    RETURN TRUE;
  END IF;
  RETURN FALSE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reconcile_rag_cost_row(UUID, UUID, DATERANGE, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_rag_cost_row(UUID, UUID, DATERANGE, BIGINT) TO service_role;

COMMENT ON FUNCTION public.reconcile_rag_cost_row(UUID, UUID, DATERANGE, BIGINT) IS
  '#692: atomic ledger-insert + tenant_usage_metrics increment for one rag_ai_call_log row. Returns TRUE iff newly counted.';
