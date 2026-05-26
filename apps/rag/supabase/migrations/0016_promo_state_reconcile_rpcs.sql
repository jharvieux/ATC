-- §6.7 — Promo state reconcile + drift count RPCs.
--
-- Two RPCs serve the hourly reconcile cron and the drift-alert cron.
-- Both are SECURITY DEFINER with the standard search_path discipline so
-- the cron's service-role client can call them.

-- reconcile_promo_status — UPDATE all promo chunks to the current expected
-- state. Returns the number of rows touched.
CREATE OR REPLACE FUNCTION public.reconcile_promo_status()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.knowledge_chunks
  SET
    promo_status = public.expected_promo_state(sell_by_start_at, sell_by_at, sail_by_at),
    promo_status_reconciled_at = NOW()
  WHERE
    (sell_by_at IS NOT NULL OR sail_by_at IS NOT NULL OR sell_by_start_at IS NOT NULL)
    AND (
      promo_status IS DISTINCT FROM
        public.expected_promo_state(sell_by_start_at, sell_by_at, sail_by_at)
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reconcile_promo_status() TO service_role;

-- count_promo_state_drift — number of promo chunks whose stored
-- promo_status doesn't match the expected state. Drives the §6.7 drift
-- alert cron.
CREATE OR REPLACE FUNCTION public.count_promo_state_drift()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM public.knowledge_chunks
  WHERE
    (sell_by_at IS NOT NULL OR sail_by_at IS NOT NULL OR sell_by_start_at IS NOT NULL)
    AND promo_status IS DISTINCT FROM
        public.expected_promo_state(sell_by_start_at, sell_by_at, sail_by_at);
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.count_promo_state_drift() TO service_role;
