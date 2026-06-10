# Session state — last updated 2026-06-10 16:00 UTC

## Standing rule (operator, permanent)
**No prod DB changes or manual prod deploys without per-instance operator approval.** Dev-merge pipeline stays autonomous.

## Just completed
- Merged PR #949 (#774 cron drain loops) and PR #950 (#831 CruiseMapper port backfill); issues #774/#785/#831 closed
- Design pass (Fable) over the four NEEDS-DESIGN issues → PR #952 (doc-only):
  - #890 inbound persona email — Resend inbound chosen over M365; Phase 1 build-ready, Phase 2 (CRM) designed/deferred
  - #712 personal API tokens — admin-only minting, no expiry
  - #811 platform-admin scoping — reviewer-only matrix
  - #781 canonical matcher — deterministic + review queue; #780 schema change recommended (alias tables, see comment on #780)
- MEMORY D-201 logged; design links commented on #890/#712/#811/#781/#780

## In flight
- PR #952 (feature/design-docs-890-712-811-781): doc-only, audit-exempt; update-branched, waiting for CI → merge when green

## Next step
1. Merge PR #952 when CI passes, delete branch
2. Build queue (all now have designs or were already READY): #890 Phase 1, #712, #811, #786, #885, #708, #780 (with alias-table schema change)

## Blocked on user
- atc-rag prod deploy (operator approval per memory)

## Open questions
- Issue #948 (vendor-health 503 granularity) — no triage comment yet
- Issue #926 (audit-check timestamp fallback removal) — open
- Issue #951 (backfill halt-on-parse-failure alert) — open follow-up
