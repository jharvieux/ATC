# Session state — last updated 2026-06-10 05:35 UTC

## Standing rule (operator, permanent)
**No prod DB changes or manual prod deploys without per-instance operator approval.** Dev-merge pipeline stays autonomous.

## Just completed
- Implemented #924: diff-hash audit binding in `pr-audit-section-check` (PR #925, merged)
- Verified already-fixed issues: #792 (RAG test), #800 (viewer role default), #850 (entity extraction active)
- Fixed #802: `payout_records.insert` now explicitly sets `currency: commission.currency` (PR #927)
- Fixed #846: cancel route CAS update uses `safeAwaitRowCount` with narrowed `try/catch` (ROW_COUNT_MISMATCH → 409, DB error → re-throw → 500) (PR #927)
- Added tests: `cancel.test.ts` (CAS-miss → 409, DB error → 500), `commission-split-currency.test.ts` (GBP currency forwarded)
- Merged PR #927 (payout fixes), PR #925 (diff-hash audit)

## In flight
- Nothing in flight — clean checkpoint

## Next step
- Continue issue backlog: #807 (bulkFlipPendingStatus partial-flip tests), #840 (Zod validation sweep in Inngest), #875 (feedback_signal_count trigger migration), #828 (chat pricing prompt scope fix)

## Blocked on user
- atc-rag prod deploy (blocked on operator approval per memory)
- Issue #869 (stale checkpoint PR, blocked on user approval to close)

## Open questions
- Issue #807: test bulkFlipPendingStatus partial-flip-on-error semantics in apps/rag
- Issue #840: 19+ baselined `event-data-cast` Inngest handlers need Zod validation sweep
- Issue #875: feedback_signal_count trigger migration needs psql via SUPABASE_RAG_DB_URL
- Issue #828: chat pricing prompt scope fix
