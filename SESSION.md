# Session state — last updated 2026-07-08 (issue-sweep hardening)

## Just completed
- **D-325: /issue-sweep hardening** after the 2026-07-07 sweep failures (12 batches at once, weak merge-driving, needless audit re-runs after update-branch, replayed command treated as gate approval). Both skill copies updated:
  - ATC `.claude/commands/issue-sweep.md` — via PR `docs/issue-sweep-hardening` (doc-only, audit-exempt).
  - User-level `~/.claude/commands/issue-sweep.md` — edited directly (outside repo).
  - Changes: `.git/issue-sweep-ledger.json` state ledger + re-entrancy guard, durable-approval plan gate (replay/silence never approve), top-up dispatch loop (max 3 executing), merge-train completion criterion + ledger-vs-`gh pr list` reconcile, update-branch-doesn't-stale-diff-hash clarification, ≤6-batch grouping coarsening, Sonnet-supervisor self-check, supervisor-never-hand-edits (fix agents at max(batch model, sonnet)).

## In flight
- PR for branch `docs/issue-sweep-hardening` (skill + MEMORY D-325 + MEMORY-INDEX + this file) — being opened/merged this session. If interrupted: branch is pushed, PR is doc-only exempt, merge when CI green.

## Next step
- Carried from previous session: execute #1686 remainder + #1687 (seed missing demo-tenant screens, add ~30 `Shot` manifest entries, `pnpm help:screenshots`, replace `[Screenshot: ...]` placeholders, land as 1-2 PRs). Then #1688 (PDF/DOCX export image rendering).

## Blocked on user
- Nothing.
- Carried: `feature/sweep-money-1606` remote branch still holds orphaned doc changes from the cancelled #1638 batch — operator to decide salvage vs let stale.

## Open questions
- Carried: GitGuardian false-positive on capture.ts `password` variable (not a required check; dismiss in dashboard if it keeps tripping).
- Carried: 13 stale locked agent worktrees under `.claude/worktrees/` — remove if the harness didn't release them.
- Carried: #1658 JPY formatCents product decision.
