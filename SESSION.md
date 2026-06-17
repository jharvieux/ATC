# Session state — last updated 2026-06-17 20:10 PT

## Just completed
- PR #1180 merged: fix(#1173) — added all 59 missing RBAC assertPermission pairs to permission-grants.ts and exhaustive test matrix. Closes #1173.
- PR #1181 merged: feat(#1176) — permission-matrix CI guard (scripts/check-permission-matrix.ts + baseline + ci.yml step + CLAUDE.md docs). Closes #1176.

## In flight
- Nothing in flight — clean checkpoint. On `dev`, synced with origin.

## Next step
- Check PR #1155 (feat: §14.9 transfer.reversed ledger unwind) — pr-audit-section-check was showing stale failure at end of prior session. Confirm it passes and merge.

## Blocked on user
- Nothing.

## Open questions
- #1156: multi-partial reversal gap — needs product decision on approach A/B/C.
- bookings.passengers:read / bookings.options:read in READ_GRANTS have no test tuples in READ_PAIRS (pre-existing latent over-grant, flagged but deferred in #1173). Track as a separate issue?
