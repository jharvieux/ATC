-- §6.7: expected_promo_state — verbatim from spec
--
-- Promo state is NOT stored state that a cron flips — it is a function of
-- current time that the reconciliation cron compares against promo_status.
-- IMMUTABLE so the optimizer can evaluate it at plan time when the arguments
-- are constants. Used both by the reconciliation cron and as the lazy-state
-- fallback in retrieval queries (§8.4).
--
-- States:
--   not_started   → NOW() < sell_by_start_at (if defined)
--   open_to_new   → sell_by_start_at reached, or no sell_by_start_at
--   closed_to_new → NOW() >= sell_by_at (filter OUT for new prospects;
--                   include for contacts with existing booking per §6.9)
--   expired       → NOW() >= sail_by_at (exclude entirely from retrieval)

CREATE OR REPLACE FUNCTION public.expected_promo_state(
  sell_by_start_at TIMESTAMPTZ,
  sell_by_at       TIMESTAMPTZ,
  sail_by_at       TIMESTAMPTZ
) RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN NOW() < sell_by_start_at THEN 'not_started'
    WHEN NOW() >= sail_by_at      THEN 'expired'
    WHEN NOW() >= sell_by_at      THEN 'closed_to_new'
    ELSE 'open_to_new'
  END;
$$;
