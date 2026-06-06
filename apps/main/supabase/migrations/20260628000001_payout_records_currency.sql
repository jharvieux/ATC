-- #799 — Add the currency column the payouts crons already SELECT.
--
-- payouts-execute-transfer + payouts-reconcile-processing read
-- payout_records.currency (row.currency.toLowerCase() → the Stripe transfer
-- currency), but no migration ever created the column, so both crons 500'd on
-- every run with `column payout_records.currency does not exist` (the /api/inngest
-- error flood). The check:dropped-columns guard missed it because the column was
-- NEVER on the table.
--
-- USD-only today (matches commissions.currency / bookings.currency). NOT NULL
-- DEFAULT 'USD' backfills existing rows so the crons' .toLowerCase() can't hit a
-- null. Additive + idempotent.

ALTER TABLE public.payout_records
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
