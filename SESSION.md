# Session state — last updated 2026-06-25 08:10 PT

## Just completed
- **#1127** — transfer.reversed ledger unwind: IMPLEMENTED + merged (PR #1423). Discovered Q6/Q7/Q8 were already shipped (#1227/#1156); added per your decisions: **Q5** negative `payout_records` 'recovery' row (additive — bucket stays live-balance source of truth) and **Q9** `reversal_idempotency_key` ledger guard (money moves only when the recovery row inserts). RPC verified against staging Postgres (full/duplicate/partial) in a ROLLBACK txn; cancel-route payout select hardened with `.neq("status","recovery")`. Follow-up #1424 (nightly DB integration test).
- **#1412** (log-injection) — fixed + merged (PR #1421).
- **#1247 strawman** — delivered + merged (PR #1420); awaiting your Q1–Q5.
- Earlier (overnight opus batch, D-298): #1376/#1377 (#1414), #1391 (#1416), #1379 (#1417) merged.

## In flight
- Nothing uncommitted except this SESSION update (docs branch → PR). No open code PRs.

## Next step
- Awaiting your inputs (below); no engineering queued.

## Blocked on user
- **#1247** — answer Q1–Q5 in `docs/proposals/1247-host-fee-tiered-strawman.md`; then ~1-file resolver + Zod validator + tests (no migration).
- **Prod migration applies** (operator, next prod deploy): `20260709…atomic_chat_limits`, `20260710…platform_revenue_idempotency_key`, `20260711…transfer_reversal_recovery_ledger` — all on dev, applied to staging/test only.
- **#1424** (sonnet) — nightly DB integration test for process_transfer_reversal. **#1415** — same for the chat-limit RPCs. **#1418** — G4 guard regen-name gap. **#1408** — detectServiceRoleTenant false-negative.
- Standing user-gated: #1365 (Supabase refresh interval), #1358/#1336 (live-Stripe cutover), #735 (OTP→Redis, reopened).

## Open questions
- CodeQL #91/#92 (log-injection) should clear on the next scan now both flows route through sanitizeForLog; dismiss with the test as evidence if CodeQL doesn't model it.
- Playwright E2E red in CI on missing TEST_E2E_OWNER_* secrets (#1286) — non-required.
