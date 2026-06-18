-- §14.9 — Fix: second partial reversal on the same transfer silently no-ops.
--
-- The original RPC's UPDATE...WHERE status='paid' loop returns 0 rows when the
-- payout_record is already 'reversed' (first reversal already processed). Stripe
-- supports multiple partial reversals on the same transfer; each delivery carries
-- a delta (amount_reversed - previous_attributes.amount_reversed). Without this
-- fix the second delivery credits nothing and the webhook logs 'unhandled'.
--
-- Fix (Option B / #1156): after the paid→reversed loop, if v_count=0, check for
-- an already-reversed row and credit the balance delta only (no re-flip). Opens
-- a second reconciliation_review_queue clawback row so ops can reconcile the
-- multi-step reversal. Commission stays disputed — no second audit row.

CREATE OR REPLACE FUNCTION public.process_transfer_reversal(
  p_transfer_id         TEXT,
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
  -- ── First pass: CAS flip paid → reversed (first/only reversal) ──────────────
  FOR r IN
    UPDATE public.payout_records
    SET    status      = 'reversed',
           reversed_at = NOW()
    WHERE  stripe_transfer_id = p_transfer_id
      AND  status             = 'paid'
    RETURNING id, tenant_id, commission_id
  LOOP
    SELECT td.hold_period_days
    INTO   v_hold_period_days
    FROM   public.tenants t
    JOIN   public.tier_definitions td ON td.id = t.tier_id
    WHERE  t.id = r.tenant_id;

    IF v_hold_period_days IS NULL THEN
      v_hold_period_days := 7;
    END IF;

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
      SELECT status
      INTO   v_old_commission_status
      FROM   public.commissions
      WHERE  id        = r.commission_id
        AND  tenant_id = r.tenant_id;

      IF v_old_commission_status IS DISTINCT FROM 'disputed' THEN
        UPDATE public.commissions
        SET    status = 'disputed'
        WHERE  id        = r.commission_id
          AND  tenant_id = r.tenant_id;

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
      END IF;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  -- ── Second pass: subsequent partial reversal (row already 'reversed') ────────
  -- Runs only when the first pass matched no paid rows. Credits the balance delta
  -- and opens a second review row; does NOT re-flip status or re-mark the
  -- commission (already 'disputed' — state machine rejects disputed→disputed).
  -- FOR UPDATE serializes concurrent calls that both reach this pass (e.g. two
  -- distinct partial-reversal events delivered close together); without it two
  -- concurrent transactions could read the same row and each apply their delta
  -- in an uncoordinated window. Concurrent legitimate events are still both
  -- credited (each applies its own p_this_reversal_cents) but in sequence.
  IF v_count = 0 THEN
    FOR r IN
      SELECT id, tenant_id, commission_id
      FROM   public.payout_records
      WHERE  stripe_transfer_id = p_transfer_id
        AND  status             = 'reversed'
      FOR UPDATE
    LOOP
      SELECT td.hold_period_days
      INTO   v_hold_period_days
      FROM   public.tenants t
      JOIN   public.tier_definitions td ON td.id = t.tier_id
      WHERE  t.id = r.tenant_id;

      IF v_hold_period_days IS NULL THEN
        v_hold_period_days := 7;
      END IF;

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

      -- Commission already disputed; skip re-mark and audit row.
      -- Open a second review row so ops can reconcile the multi-step reversal.
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
          'payout_record_id',   r.id,
          'partial_reversal_sequence', true
        )::text
      );

      v_count := v_count + 1;
    END LOOP;
  END IF;

  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.process_transfer_reversal(TEXT, BIGINT) FROM public;
GRANT  EXECUTE ON FUNCTION public.process_transfer_reversal(TEXT, BIGINT) TO service_role;
