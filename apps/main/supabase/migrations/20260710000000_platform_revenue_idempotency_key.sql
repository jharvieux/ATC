-- F-pay-01 robust fix (#1391) — idempotency key on the clawback ledger insert.
--
-- #1390 closed the concurrent-double-count window for settled-payout clawbacks
-- with a status-CAS, but a residual remained: a crash BETWEEN the payout
-- status-CAS (→'reversed') and the negative platform_revenue insert left the
-- payout terminally 'reversed' with no ledger row, and retries dead-ended at 409
-- (the CAS then matched 0 rows). Root cause: platform_revenue had no
-- single-entry guard of its own, so correctness depended on payout-status
-- ordering.
--
-- Fix: a unique idempotency_key makes the ledger INSERT itself the single-entry
-- guard (ON CONFLICT DO NOTHING), independent of payout status. The clawback
-- flow can then run reversal → idempotent ledger insert → idempotent status
-- flip, so a crash anywhere between the reversal and the insert is fully
-- recoverable on retry with no stranded payout and no missing/duplicate row.
--
-- Additive only — no read path changes columns, so no expand→switch→contract is
-- required. The index is NON-partial on purpose: Postgres treats NULLs as
-- distinct, so the column's existing all-NULL rows never collide, yet a plain
-- ON CONFLICT (idempotency_key) can still INFER this index (a partial index
-- could not be inferred without a matching WHERE clause, which supabase-js
-- can't emit).

ALTER TABLE public.platform_revenue
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS platform_revenue_idempotency_key_uniq
  ON public.platform_revenue (idempotency_key);

COMMENT ON COLUMN public.platform_revenue.idempotency_key IS
  'F-pay-01 (#1391): single-entry guard for clawback/reversal ledger rows. The clawback insert uses ON CONFLICT DO NOTHING on this key so concurrent cancels and post-crash retries collapse to exactly one negative row, independent of payout status. NULL for ordinary (non-idempotent) revenue rows.';
