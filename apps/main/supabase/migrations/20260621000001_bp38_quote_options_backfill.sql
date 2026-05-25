-- BP38 §38 — Deploy 2 (MIGRATE): backfill quote_options from existing quotes.
--
-- For each existing quote that doesn't already have a quote_options row,
-- create option_index=1 carrying the existing per-option columns. Idempotent:
-- safe to re-run because of the UNIQUE (quote_id, option_index) constraint
-- combined with the WHERE NOT EXISTS guard.

INSERT INTO public.quote_options (
  tenant_id, quote_id, option_index, cruise_line, ship_name, sailing_date,
  duration_nights, cabin_category, passenger_count,
  commissionable_fare_cents, non_commissionable_total_cents, total_amount_cents,
  currency
)
SELECT
  q.tenant_id,
  q.id,
  1,
  q.cruise_line,
  q.ship_name,
  q.sailing_date,
  q.duration_nights,
  q.cabin_category,
  -- passenger_count may not exist as a column on quotes pre-BP38; cast NULL.
  NULL::INTEGER,
  -- Money columns on the existing quotes table were renamed to *_cents in
  -- the §14.0 money refactor; if any tenant DB is on the older schema this
  -- COALESCE-with-NULL keeps the backfill from failing.
  q.commissionable_fare,
  q.non_commissionable_total,
  q.total_amount,
  'USD'
FROM public.quotes q
WHERE NOT EXISTS (
  SELECT 1 FROM public.quote_options o WHERE o.quote_id = q.id
);
