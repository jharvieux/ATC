-- §14.9 — Clawback support: extend reconciliation_review_queue status and add
-- a single atomic RPC that handles the full transfer.reversed ledger unwind.

-- 1. Extend status CHECK to include 'clawback' (used by transfer.reversed handler).
ALTER TABLE public.reconciliation_review_queue
  DROP CONSTRAINT IF EXISTS reconciliation_review_queue_status_check;

ALTER TABLE public.reconciliation_review_queue
  ADD CONSTRAINT reconciliation_review_queue_status_check
  CHECK (status IN ('pending', 'accepted', 'rejected', 'orphan', 'clawback'));

-- 2. Atomic transfer reversal handler. Executes in a single transaction:
--    a. CAS flip payout_records paid→reversed (returns matched rows)
--    b. Deducts from payout_balances.available_cents for each row (clawback)
--    c. Marks the linked commission 'disputed' and opens a clawback review row
--    Returns the count of payout_records rows processed (0 = not ours / already reversed).
--
--    A single function avoids the crash window between a multi-call sequence
--    where status flip commits but the balance credit or commission update does
--    not (D-091 P8). The payout_balances INSERT uses ON CONFLICT DO UPDATE so a
--    pre-existing row is the common path; the INSERT branch uses the tenant's
--    tier hold_period_days (required NOT NULL column) looked up live.
CREATE OR REPLACE FUNCTION public.process_transfer_reversal(
  p_transfer_id       TEXT,
  p_this_reversal_cents BIGINT
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r                       RECORD;
  v_hold_period_days      INTEGER;
  v_old_commission_status TEXT;
  v_count                 INTEGER := 0;
BEGIN
  FOR r IN
    UPDATE public.payout_records
    SET    status      = 'reversed',
           reversed_at = NOW()
    WHERE  stripe_transfer_id = p_transfer_id
      AND  status             = 'paid'
    RETURNING id, tenant_id, commission_id
  LOOP
    -- hold_period_days is NOT NULL on payout_balances with no column default;
    -- look it up from the tenant's tier so the INSERT branch is valid.
    SELECT td.hold_period_days
    INTO   v_hold_period_days
    FROM   public.tenants t
    JOIN   public.tier_definitions td ON td.id = t.tier_id
    WHERE  t.id = r.tenant_id;

    IF v_hold_period_days IS NULL THEN
      v_hold_period_days := 7;  -- conservative default if tenant has no tier
    END IF;

    -- Deduct from available: reversal is a clawback, not a credit (§14.9).
    -- Passing -p_this_reversal_cents keeps the ON CONFLICT arithmetic sign-consistent.
    INSERT INTO public.payout_balances (
      tenant_id, available_cents, pending_cents, in_transit_cents,
      hold_period_days, updated_at
    ) VALUES (
      r.tenant_id, -p_this_reversal_cents, 0, 0,
      v_hold_period_days, NOW()
    )
    ON CONFLICT (tenant_id) DO UPDATE
      SET available_cents = public.payout_balances.available_cents + EXCLUDED.available_cents,
          updated_at      = NOW();

    IF r.commission_id IS NOT NULL THEN
      -- Capture the pre-transition status so the audit row records from→to,
      -- mirroring the app-layer state machine (transitionCommissionState).
      SELECT status
      INTO   v_old_commission_status
      FROM   public.commissions
      WHERE  id        = r.commission_id
        AND  tenant_id = r.tenant_id;

      -- Skip if already disputed: two payout_records sharing a commission_id
      -- (possible when payout_intent IS NULL) would otherwise produce a
      -- spurious disputed→disputed audit row the app-layer state machine rejects.
      IF v_old_commission_status IS DISTINCT FROM 'disputed' THEN
      UPDATE public.commissions
      SET    status = 'disputed'
      WHERE  id        = r.commission_id
        AND  tenant_id = r.tenant_id;

      -- This RPC is the only commission status change outside the app-layer
      -- state machine; without this row the §14.9 clawback transition would
      -- leave no audit trail, while every other transition logs one.
      INSERT INTO public.audit_log (
        tenant_id, actor_type, action, resource_type, resource_id, changes
      ) VALUES (
        r.tenant_id,
        'system',
        'commission.state_transition',
        'commission',
        r.commission_id,
        jsonb_build_object(
          'from',               v_old_commission_status,
          'to',                 'disputed',
          'reason',             'transfer_reversed',
          'stripe_transfer_id', p_transfer_id
        )
      );

      INSERT INTO public.reconciliation_review_queue (
        commission_id, tenant_id, variance_cents, source_path, status, notes
      ) VALUES (
        r.commission_id,
        r.tenant_id,
        p_this_reversal_cents,
        'automated',
        'clawback',
        json_build_object(
          'stripe_transfer_id', p_transfer_id,
          'reversed_cents',     p_this_reversal_cents,
          'payout_record_id',   r.id
        )::text
      );
      END IF;  -- IS DISTINCT FROM 'disputed'
    END IF;  -- commission_id IS NOT NULL

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.process_transfer_reversal(TEXT, BIGINT) FROM public;
GRANT  EXECUTE ON FUNCTION public.process_transfer_reversal(TEXT, BIGINT) TO service_role;
