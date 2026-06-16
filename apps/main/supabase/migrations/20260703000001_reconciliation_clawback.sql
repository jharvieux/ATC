-- §14.9 — Clawback support: extend reconciliation_review_queue status enum
-- and add an atomic RPC for crediting payout_balances.available_cents.

-- 1. Extend status CHECK to include 'clawback' (used by transfer.reversed handler).
ALTER TABLE public.reconciliation_review_queue
  DROP CONSTRAINT reconciliation_review_queue_status_check;

ALTER TABLE public.reconciliation_review_queue
  ADD CONSTRAINT reconciliation_review_queue_status_check
  CHECK (status IN ('pending', 'accepted', 'rejected', 'orphan', 'clawback'));

-- 2. Atomic available_cents credit. Supabase JS .update() cannot reference
--    the current column value (no SET x = x + delta), so the atomicity
--    requirement for the clawback credit requires a server-side function.
--    UPSERTs so a missing payout_balances row is created rather than errored.
CREATE OR REPLACE FUNCTION public.credit_payout_balance_available(
  p_tenant_id   UUID,
  p_amount_cents BIGINT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO payout_balances (tenant_id, available_cents, pending_cents, in_transit_cents, updated_at)
  VALUES (p_tenant_id, p_amount_cents, 0, 0, NOW())
  ON CONFLICT (tenant_id) DO UPDATE
    SET available_cents = payout_balances.available_cents + EXCLUDED.available_cents,
        updated_at      = NOW();
END;
$$;

REVOKE EXECUTE ON FUNCTION public.credit_payout_balance_available(UUID, BIGINT) FROM public;
GRANT EXECUTE ON FUNCTION public.credit_payout_balance_available(UUID, BIGINT) TO service_role;
