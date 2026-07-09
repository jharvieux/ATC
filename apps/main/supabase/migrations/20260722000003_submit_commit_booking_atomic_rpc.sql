-- Migration: submit_commit_booking_atomic_rpc
-- Version:   20260722000003
-- Generated: 2026-07-09 by scripts/new-migration.sh
-- Branch:    feature/sweep-booking-1693
-- Worktree:  agent-a7b71c7a0dfcd88d4
--
-- §14.3 / §14.4 / #1693 (deferred from #1577) — atomic booking-submit commit.
--
-- After the host adapter call succeeds, apps/main/src/app/api/bookings/[id]/submit
-- persisted provider_booking_ref in its own write (money-safety, #1577), then did
-- TWO more dependent, non-atomic service-role writes: (1) a commissions INSERT
-- (skipped in sandbox), then (2) a bookings UPDATE → 'submitted'. A crash between
-- them left a booking with a persisted host ref + a commission row but status still
-- 'submitting'; the stuck-submitting reconcile cron then routes it to
-- pending_host_review (reason host_state_unknown) — money-safe but manual-review
-- toil. This RPC folds the commission insert and the final status flip into ONE
-- transaction: the commission row is inserted idempotently, and the status flips to
-- 'submitted' only if the row is still 'submitting'. A lost race (something else
-- moved the booking off 'submitting' first, e.g. reconcile) leaves the idempotent
-- 'expected' commission in place with the status unflipped — benign, since nothing
-- is paid on an 'expected' commission — and the caller routes the row to review; the
-- manual pending_host_review resolution path must tolerate that pre-existing
-- commission row rather than assuming a clean slate (#1755).
--
-- Idempotent against the commissions(booking_id) UNIQUE index (#1575,
-- commissions_booking_id_uidx): the INSERT uses ON CONFLICT (booking_id) DO NOTHING
-- so a retry that already wrote the commission still flips the status without a
-- 23505. The status flip is CAS-guarded on status = 'submitting' (the caller holds
-- that CAS lock) AND tenant_id (§ two-layer isolation), and the function returns the
-- number of booking rows flipped so the caller can distinguish committed (1) from
-- lost-race / already-moved (0). Sandbox tenants skip the commission insert entirely
-- (§15.12) but still flip to 'submitted'.
--
-- SECURITY DEFINER with an empty search_path (every object schema-qualified) so the
-- service-role caller runs it under RLS; EXECUTE revoked from PUBLIC, granted only to
-- service_role — modeled on public.undo_session_transfer (#1703).

CREATE OR REPLACE FUNCTION public.submit_commit_booking(
  p_booking_id                UUID,
  p_tenant_id                 UUID,
  p_provider_booking_ref      TEXT,
  p_host_adapter              TEXT,
  p_is_sandbox                BOOLEAN,
  p_commissionable_fare_cents BIGINT,
  p_commission_rate           NUMERIC,
  p_platform_split_rate       NUMERIC,
  p_gross_commission_cents    BIGINT,
  p_host_booking_fee_cents    BIGINT,
  p_host_booking_fee_rule_ref TEXT,
  p_net_commission_cents      BIGINT,
  p_platform_retained_cents   BIGINT,
  p_subhost_payable_cents     BIGINT,
  p_currency                  TEXT
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  -- §15.12 — commissions are NOT created in sandbox mode. ON CONFLICT DO NOTHING
  -- makes a crash-retry safe: a second attempt that already inserted the row is a
  -- no-op, not a 23505 that would abort the transaction and block the status flip.
  IF NOT p_is_sandbox THEN
    INSERT INTO public.commissions (
      tenant_id,
      booking_id,
      commissionable_fare_cents,
      commission_rate,
      platform_split_rate,
      gross_commission_cents,
      host_booking_fee_cents,
      host_booking_fee_rule_ref,
      net_commission_cents,
      platform_retained_cents,
      subhost_payable_cents,
      currency,
      status
    ) VALUES (
      p_tenant_id,
      p_booking_id,
      p_commissionable_fare_cents,
      p_commission_rate,
      p_platform_split_rate,
      p_gross_commission_cents,
      p_host_booking_fee_cents,
      p_host_booking_fee_rule_ref,
      p_net_commission_cents,
      p_platform_retained_cents,
      p_subhost_payable_cents,
      p_currency,
      'expected'
    )
    ON CONFLICT (booking_id) DO NOTHING;
  END IF;

  -- Flip the CAS lock the caller holds (status = 'submitting') to 'submitted'.
  -- tenant-scoped (§ two-layer isolation). Zero rows means a concurrent path
  -- (e.g. the reconcile cron) already moved the row on → caller routes to review.
  UPDATE public.bookings
  SET    status               = 'submitted',
         provider_booking_ref = p_provider_booking_ref,
         host_adapter         = p_host_adapter,
         submitted_at         = NOW(),
         updated_at           = NOW()
  WHERE  id        = p_booking_id
    AND  tenant_id = p_tenant_id
    AND  status    = 'submitting';

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.submit_commit_booking(
  UUID, UUID, TEXT, TEXT, BOOLEAN, BIGINT, NUMERIC, NUMERIC, BIGINT, BIGINT, TEXT, BIGINT, BIGINT, BIGINT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_commit_booking(
  UUID, UUID, TEXT, TEXT, BOOLEAN, BIGINT, NUMERIC, NUMERIC, BIGINT, BIGINT, TEXT, BIGINT, BIGINT, BIGINT, TEXT
) TO service_role;

COMMENT ON FUNCTION public.submit_commit_booking(
  UUID, UUID, TEXT, TEXT, BOOLEAN, BIGINT, NUMERIC, NUMERIC, BIGINT, BIGINT, TEXT, BIGINT, BIGINT, BIGINT, TEXT
) IS
  '#1693: atomically inserts the commission row (ON CONFLICT (booking_id) DO NOTHING; skipped for sandbox tenants) and CAS-flips bookings.status submitting → submitted with provider_booking_ref/submitted_at in one transaction. Returns booking rows flipped (0 = lost race → caller routes to pending_host_review).';
