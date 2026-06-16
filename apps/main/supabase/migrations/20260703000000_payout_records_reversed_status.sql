-- §14.9 — payout_records: add 'reversed' status for Stripe transfer reversals (clawback).
--
-- Modern Stripe (separate charges-and-transfers) settles a Transfer the instant
-- transfers.create() returns and never emits transfer.paid, so settlement now
-- happens synchronously in payouts-execute-transfer / payouts-reconcile-processing.
-- The platform endpoint instead subscribes to transfer.reversed (§14.9 clawback,
-- 60-day window). A reversed transfer needs a terminal status distinct from 'paid'.
--
-- Expand-only: this widens the CHECK constraint (adds a value) and adds a nullable
-- column. No reader of the old states breaks, so it is safe to ship in one PR
-- (BP38 expand-migrate-contract applies to drops/renames, not value additions).

ALTER TABLE public.payout_records
  DROP CONSTRAINT IF EXISTS payout_records_status_check;

ALTER TABLE public.payout_records
  ADD CONSTRAINT payout_records_status_check
    CHECK (status IN ('pending','available','processing','paid','failed','cancelled','reversed'));

-- Timestamp of the reversal, mirroring settled_at / failed_at.
ALTER TABLE public.payout_records
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
