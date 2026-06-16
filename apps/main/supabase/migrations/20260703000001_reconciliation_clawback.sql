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
--    b. Credits payout_balances.available_cents for each row
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
SET search_path = public
AS $$
DECLARE
  r                  RECORD;
  v_hold_period_days INTEGER;
  v_count            INTEGER := 0;
BEGIN
  FOR r IN
    UPDATE payout_records
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
    FROM   tenants t
    JOIN   tier_definitions td ON td.id = t.tier_id
    WHERE  t.id = r.tenant_id;

    IF v_hold_period_days IS NULL THEN
      v_hold_period_days := 7;  -- conservative default if tenant has no tier
    END IF;

    INSERT INTO payout_balances (
      tenant_id, available_cents, pending_cents, in_transit_cents,
      hold_period_days, updated_at
    ) VALUES (
      r.tenant_id, p_this_reversal_cents, 0, 0,
      v_hold_period_days, NOW()
    )
    ON CONFLICT (tenant_id) DO UPDATE
      SET available_cents = payout_balances.available_cents + EXCLUDED.available_cents,
          updated_at      = NOW();

    IF r.commission_id IS NOT NULL THEN
      UPDATE commissions
      SET    status = 'disputed'
      WHERE  id        = r.commission_id
        AND  tenant_id = r.tenant_id;

      INSERT INTO reconciliation_review_queue (
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
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.process_transfer_reversal(TEXT, BIGINT) FROM public;
GRANT  EXECUTE ON FUNCTION public.process_transfer_reversal(TEXT, BIGINT) TO service_role;
