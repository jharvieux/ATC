-- §14.9 / #1127 — transfer.reversed: negative recovery-row ledger + ledger guard.
--
-- process_transfer_reversal already flips paid→reversed, debits
-- payout_balances.available_cents, marks the commission disputed, and opens a
-- reconciliation_review_queue row (Q6/Q7/Q8 — #1227/#1156). This adds the two
-- spec-owner decisions still outstanding on #1127:
--
--   Q5 — represent the reversal as a NEGATIVE payout_records 'recovery' row
--        (ADDITIVE: the row is the durable ledger/audit entry; the available_cents
--        debit stays the live-balance source of truth). The row is invisible to
--        the payout readers, which all filter on explicit statuses
--        (balance: pending|available; history: a validated status enum; the crons
--        scan processing/etc.) — so a 'recovery' row never corrupts balances,
--        statements, or history.
--   Q9 — a LEDGER-level idempotency guard: a unique reversal_idempotency_key
--        (transfer_id:event_id) on the recovery row. The recovery INSERT is the
--        idempotency anchor — ON CONFLICT DO NOTHING — and the money movement is
--        applied ONLY when that row actually inserts. So a re-delivered partial
--        reversal can't double-credit even if the stripe_webhook_events dedup row
--        was cleared (defense beyond the webhook layer).
--
-- Expand-only: widens a CHECK (adds a value), adds a nullable column + index,
-- and CREATE OR REPLACEs the function (signature unchanged). No reader breaks.

-- 1. Allow the negative recovery row's status.
ALTER TABLE public.payout_records
  DROP CONSTRAINT IF EXISTS payout_records_status_check;
ALTER TABLE public.payout_records
  ADD CONSTRAINT payout_records_status_check
    CHECK (status IN ('pending','available','processing','paid','failed','cancelled','reversed','recovery'));

-- 2. Ledger idempotency key. Non-partial unique index so ON CONFLICT can infer
--    it; NULLs are distinct, so the column's existing all-NULL rows never collide.
ALTER TABLE public.payout_records
  ADD COLUMN IF NOT EXISTS reversal_idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS payout_records_reversal_idem_key_uniq
  ON public.payout_records (reversal_idempotency_key);
COMMENT ON COLUMN public.payout_records.reversal_idempotency_key IS
  'F-#1127: per-(stripe_transfer_id:stripe_event_id) idempotency anchor for the negative recovery row written on transfer.reversed. NULL for ordinary payout rows. Globally unique (the key embeds the transfer id).';

-- 3. RPC: add the recovery row (Q5) + gate money movement on its idempotent
--    insert (Q9), keeping the existing balance debit / disputed / review row.
CREATE OR REPLACE FUNCTION public.process_transfer_reversal(
  p_transfer_id         TEXT,
  p_this_reversal_cents BIGINT,
  p_stripe_event_id     TEXT
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r                       RECORD;
  v_hold_period_days      INTEGER;
  v_old_commission_status TEXT;
  v_key                   TEXT := p_transfer_id || ':' || COALESCE(p_stripe_event_id, '');
  v_recovery_inserted     INTEGER := 0;
BEGIN
  -- Flip the original transfer paid → reversed (CAS; fires once across redeliveries).
  UPDATE public.payout_records
  SET    status = 'reversed', reversed_at = NOW()
  WHERE  stripe_transfer_id = p_transfer_id
    AND  status = 'paid';

  -- Locate the original row (unique stripe_transfer_id — exactly one) and lock it
  -- so concurrent partial-reversal events serialize. Recovery rows carry a NULL
  -- stripe_transfer_id, so they never match here.
  SELECT id, tenant_id, commission_id
  INTO   r
  FROM   public.payout_records
  WHERE  stripe_transfer_id = p_transfer_id
    AND  status = 'reversed'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 0;  -- no payout row for this transfer — not ours
  END IF;

  -- Q5 + Q9: negative recovery row = durable ledger entry + idempotency anchor.
  INSERT INTO public.payout_records (
    tenant_id, amount_cents, status, commission_id, reversal_idempotency_key, created_at
  ) VALUES (
    r.tenant_id, -p_this_reversal_cents, 'recovery', r.commission_id, v_key, NOW()
  )
  ON CONFLICT (reversal_idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_recovery_inserted = ROW_COUNT;

  IF v_recovery_inserted = 0 THEN
    RETURN 0;  -- this exact (transfer, event) already applied — idempotent no-op
  END IF;

  -- Additive: debit the live balance (available_cents). The recovery row above is
  -- the ledger trail; this bucket remains the source of truth for balance reads.
  SELECT td.hold_period_days
  INTO   v_hold_period_days
  FROM   public.tenants t
  JOIN   public.tier_definitions td ON td.id = t.tier_id
  WHERE  t.id = r.tenant_id;
  IF v_hold_period_days IS NULL THEN
    v_hold_period_days := 7;
  END IF;

  INSERT INTO public.payout_balances (
    tenant_id, available_cents, pending_cents, in_transit_cents, hold_period_days, updated_at
  ) VALUES (
    r.tenant_id, -p_this_reversal_cents, 0, 0, v_hold_period_days, NOW()
  )
  ON CONFLICT (tenant_id) DO UPDATE
    SET available_cents = public.payout_balances.available_cents + EXCLUDED.available_cents,
        updated_at      = NOW();

  -- Commission → disputed (guarded; idempotent across partials).
  IF r.commission_id IS NOT NULL THEN
    SELECT status
    INTO   v_old_commission_status
    FROM   public.commissions
    WHERE  id = r.commission_id AND tenant_id = r.tenant_id;

    IF v_old_commission_status IS DISTINCT FROM 'disputed' THEN
      UPDATE public.commissions
      SET    status = 'disputed'
      WHERE  id = r.commission_id AND tenant_id = r.tenant_id;

      INSERT INTO public.audit_log (
        tenant_id, actor_type, action, resource_type, resource_id, changes
      ) VALUES (
        r.tenant_id, 'system', 'commission.state_transition', 'commission', r.commission_id,
        jsonb_build_object(
          'from', v_old_commission_status, 'to', 'disputed',
          'reason', 'transfer_reversed', 'stripe_transfer_id', p_transfer_id
        )
      );
    END IF;

    -- One reconciliation review row per applied reversal delta.
    INSERT INTO public.reconciliation_review_queue (
      commission_id, tenant_id, variance_cents, source_path, status, notes
    ) VALUES (
      r.commission_id, r.tenant_id, p_this_reversal_cents, 'automated', 'clawback',
      json_build_object(
        'stripe_transfer_id', p_transfer_id,
        'stripe_event_id',    p_stripe_event_id,
        'reversed_cents',     p_this_reversal_cents,
        'payout_record_id',   r.id
      )::text
    );
  END IF;

  RETURN 1;
END;
$$;

-- service_role is the only caller (the Stripe webhook handler); re-assert the
-- least-privilege grants (CREATE OR REPLACE keeps existing grants, but §5.1.1
-- requires the REVOKE to be explicit in the migration).
REVOKE EXECUTE ON FUNCTION public.process_transfer_reversal(TEXT, BIGINT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_transfer_reversal(TEXT, BIGINT, TEXT) TO service_role;
