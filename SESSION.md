# Session state — last updated 2026-06-15 (PR #1128 merged)

## Just completed
- **PR #1128 merged (squash) into dev** — synchronous payout settlement; drop `transfer.paid`, add `transfer.reversed`. Branch `feature/payout-settlement-sync` deleted.
  - execute-transfer settles `processing`→`paid` in the same step as `transfers.create()` (CAS-guarded, 0-row = log-not-throw).
  - reconcile cron: both branches settle via `settleReconciledRow` helper (same guard).
  - webhook-handler: `transfer.paid` case removed; `transfer.reversed` clawback case added (status→`reversed`+`reversed_at`, guarded on `status='paid'`; 0-row→`unhandled`/200, DB-error→500).
  - migration `20260703000000_payout_records_reversed_status.sql` — expand-only (CHECK widen + nullable `reversed_at`).
  - Tests across 8 files updated (transfer.paid removed, transfer.reversed + 'paid' settle assertions added). `pnpm verify` green; vitest 85 passed.
- Both audit agents clean (d091 Opus + pre-pr), hash-bound to diff `806273e5…705dc`.
- Filed issue #1129 (no-code config: subscribe endpoint to `transfer.reversed`). Issue #1127 already tracks deferred §14.9 ledger unwind.
- MEMORY.md D-242 added.

## In flight
- Nothing in flight — clean checkpoint. Local `dev` fast-forwarded to merged commit `cd316e4c`.

## Next step
- New work as directed. No outstanding task from the payout-settlement work.

## Blocked on user
- **Operator action at deploy time:** subscribe the platform Stripe webhook endpoint to `transfer.reversed` (optionally `transfer.created`) and drop `transfer.paid`. If not enabled, clawbacks silently never arrive. Tracked as #1129. (Per the no-prod-deploys-without-asking rule, this is an operator step — not auto-applied.)

## Open questions
- #1127 — §14.9 clawback ledger unwind (money-movement reversal accounting) is deferred; the `transfer.reversed` handler is status-only. Needs §14.9 accounting decision before implementing.

## Untracked (do NOT stage)
- `apps/main/stripe-sandbox-price-ids.env` — pre-existing untracked file, leave alone.
