-- BP38 §38 — Deploy 3 (CONTRACT): drop per-option columns from quotes.
--
-- Per §38.2.3 this is the final step after the application has switched
-- reads to quote_options and stopped writing to these columns. Run after
-- the previous two migrations + the read-switchover code is live.

ALTER TABLE public.quotes
  DROP COLUMN IF EXISTS cruise_line,
  DROP COLUMN IF EXISTS ship_name,
  DROP COLUMN IF EXISTS sailing_date,
  DROP COLUMN IF EXISTS duration_nights,
  DROP COLUMN IF EXISTS cabin_category,
  DROP COLUMN IF EXISTS passenger_count,
  DROP COLUMN IF EXISTS commissionable_fare,
  DROP COLUMN IF EXISTS non_commissionable_total,
  DROP COLUMN IF EXISTS total_amount;
