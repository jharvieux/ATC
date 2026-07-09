# Session state — last updated 2026-07-09 18:05 CT (#1727 skill update)

## Just completed
- **#1727 — /issue-sweep skill updated with the 2026-07-09 sweep lessons (D-328)**: canonical verbatim executor safeguard block (test-DB exception inline, foreground verify, no-MEMORY-writes), marker staleness corrected to file-overlap + rebind re-audit codified, merge-train ordering by test-DB ledger owner, cancelled-run rerun rule, poll-until-zero-pending CI waits, batch-count scaling. Both copies updated: ATC `.claude/commands/issue-sweep.md` (via doc-only PR) and user-level `~/.claude/commands/issue-sweep.md` (edited in place — lives outside the repo).
- Confirmed sweep wrapup PR #1732 merged (was in flight at last checkpoint).

## In flight
- PR for branch `docs/issue-sweep-lessons-1727` (skill update + MEMORY D-328 + MEMORY-INDEX + this file) — doc-only, audit-exempt; merge when CI green, then close #1727. If interrupted: branch pushed, just merge and close the issue.

## Next step
- Operator actions from the sweep (below), then the nightly-failure cluster (#1692 down to #1498 — 13 issues, likely shared root causes, untouched by the sweep as below-cutoff).

## Blocked on user
- **Prod applies (gated by no-prod-deploys rule):** main-app migration backlog includes all sweep migrations (#1623 tracks; last prod apply 20260708000000); RAG migrations from #1710 need manual psql (SUPABASE_RAG_DB_URL) + `cd apps/rag && vercel deploy --prod --yes` (merging did NOT deploy RAG).
- **Dashboard/secrets:** Supabase leaked-password protection toggle (#1523); `SUPABASE_ACCESS_TOKEN` CI secret for the advisor check (#1635, workflow ships disabled-loud without it); Resend inbound provisioning for #890 Phase 1 (MX record, webhook endpoint + RESEND_INBOUND_WEBHOOK_SECRET, Receiving-API path confirmation — steps in PR #1725 body); TEST_E2E_OWNER_* secrets (#1286) to activate the onboarding-funnel spec.
- **Decisions:** #1609 (amend spec §8.3/§8.7 for Inngest delivery, or close won't-do); #1247 (answer strawman Q1–Q5 in docs/proposals/1247-host-fee-tiered-strawman.md); #1611 (re-scope storage approach — 3 options posted on the issue); #1585 (green-light the dedicated trusted-header auth PR when ready).

## Open questions
- Carried: GitGuardian false-positive on capture.ts `password` var (dismiss in dashboard if it keeps tripping).
- Carried: ~16 stale locked agent worktrees under `.claude/worktrees/` predating recent sessions (incl. `feature/sweep-auth-1604`, `feature/sweep-money-1606` orphaned branch) — operator to decide salvage vs delete.
- Phase-2 parked set (#1257–#1262, #444) and #1358/#895/#1686 remain open by design — queue a follow-up sweep when their external blockers clear.
