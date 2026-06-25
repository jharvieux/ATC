# Session state — last updated 2026-06-25 01:00 PT

## Just completed
- **Overnight opus batch** (D-298). Of the 6 engineering-ready opus issues:
  - ✅ **#1376 + #1377** — atomic chat-limit counters (PR #1414, merged). Follow-up #1415.
  - ✅ **#1391** — clawback idempotency key (PR #1416, merged).
  - ✅ **#1379** — session-bound + throttled OTP flow (PR #1417, merged). Reopened #735.
  - ⛔ **#1247** — host-fee tiered/threshold: SKIPPED, blocked on spec-owner decision (tiered_rules shape + threshold rule undefined in §12.6/§14). Commented.
  - ⛔ **#1127** — transfer.reversed ledger unwind: SKIPPED, blocked on spec-owner decision (§14.9 defines no money-movement semantics). Commented.
- All three merged PRs shipped **migrations applied to staging/test only; prod apply gated**.
- Follow-ups filed: #1415 (DB-level concurrency test for chat-limit RPCs), #1418 (G4 guard misses `regen`-named limiter Maps).

## In flight
- This MEMORY/SESSION/INDEX update is on branch `docs/opus-batch-session` (about to PR → dev). Otherwise nothing uncommitted; all feature work merged.

## Next step
- Merge the `docs/opus-batch-session` doc PR.
- Awaiting operator decisions to unblock #1247 and #1127 (both need money-movement semantics defined — see the issue comments for the exact questions).

## Blocked on user
- **#1247** — define host-fee `tiered_rules` JSONB shape, commission-vs-fare basis, and `minimum_commission_threshold` rule.
- **#1127** — define the transfer.reversed ledger unwind (balance bucket, commission state, partial-reversal representation).
- **#1412** — 2 `js/log-injection` code-scanning alerts (shipped code): fix vs. dismiss.
- Prod migration applies for the 3 merged PRs (20260709 atomic chat limits, 20260710 platform_revenue idempotency_key) when ready.
- Standing user-gated items: #1365 (Supabase refresh interval), #1379-class prod auth config, live-Stripe cutover (#1358).

## Open questions
- Playwright E2E still red in CI on missing TEST_E2E_OWNER_* secrets (#1286) — non-required, not caused by these changes.
