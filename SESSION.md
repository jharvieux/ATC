# Session state — last updated 2026-06-25 07:25 PT

## Just completed
- **#1412** (CWE-117 log-injection) — FIXED + merged (PR #1421): shared `sanitizeForLog()` (lib/log/sanitize.ts) applied at chat/route.ts + auth/respond.ts, with tests. (Audit caught literal-control-bytes-in-source → rebuilt the class via String.fromCharCode for readable source.)
- **#1247 strawman** — built + merged (PR #1420, `docs/proposals/1247-host-fee-tiered-strawman.md`) and linked on #1247: proposes the `tiered_rules` JSONB shape + the 3 `minimum_commission_threshold` options (recommends A) + worked examples + the Q1–Q5 decisions the spec owner must answer.
- Earlier this session (overnight opus batch, D-298): #1376/#1377 (PR #1414), #1391 (PR #1416), #1379 (PR #1417) all merged.

## In flight
- Nothing uncommitted except this SESSION update (on a docs branch → PR). No open code PRs.

## Next step
- Nothing queued. Awaiting operator/spec-owner inputs below before more engineering on the deferred items.

## Blocked on user
- **#1247** — answer Q1–Q5 in `docs/proposals/1247-host-fee-tiered-strawman.md` (tiered_rules shape, basis, flat-per-bracket vs marginal, threshold rule). Then it's a ~1-file resolver change + Zod validator + tests (no migration).
- **#1127** — define the transfer.reversed ledger unwind (balance bucket, commission state, partial-reversal representation) — see issue comment.
- **Prod migration applies** — operator to apply in the next prod deployment (confirmed): `20260709000000_atomic_chat_limit_counters`, `20260710000000_platform_revenue_idempotency_key` (both already on dev, applied to staging/test only).
- Standing user-gated: #1365 (Supabase refresh interval), #1358/#1336 (live-Stripe cutover), #735 (OTP limiters → Redis, reopened).

## Open questions
- CodeQL alerts #91/#92 should clear on the next scan now that both flows route through sanitizeForLog; if CodeQL doesn't model it as a barrier, dismiss with the test as evidence.
- Playwright E2E still red in CI on missing TEST_E2E_OWNER_* secrets (#1286) — non-required.
