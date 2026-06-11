# Session state — last updated 2026-06-11 15:45 UTC

## Standing rule (operator, permanent)
**No prod DB changes or manual prod deploys without per-instance operator approval.** Dev-merge pipeline stays autonomous.
**Note (D-205):** there is currently ONE Supabase project (mfaknjyqiwcjojukcnea) serving production — MCP applies ARE prod applies. Gate accordingly until #386/#534 split environments.

## Just completed
- Tenant branding applied at runtime (§16.2), D-209 — **PR #1009 opened into dev** from `claude/tenant-branding-ui-1piloz`
- Both audit agents ran (Opus first run, 18-file diff): d091 PASS (2 nits), pre-pr clean (2 informational nits); nit fixes pushed; PR `## Audit` section filled with combined report + Status line
- Opened issue #1008 (remaining unbranded customer surfaces, deferred)

## In flight
- **Open-PR sweep done (user request).** State:
  - **#995 (PATs) MERGED** (squash) — fully green incl. audit check. Branch `feature/712-personal-api-tokens` NOT deleted (git proxy in this remote session only accepts the designated branch; delete from a gh session).
  - **#993, #994, #1007**: ALL CI green EXCEPT `pr-audit-section-check` — marker-comment diff-hash mismatch (D-204 pattern: update-branch reconciled shared snapshot files → new effective diff). Need both audit agents re-run from a gh-capable session to restamp hashes. #993/#994 also now BEHIND after #995's merge — update-branch first, serially (both touch db snapshots), then re-audit, then merge.
  - **#1009 (this branch)**: update-branched onto post-#995 dev; CI re-running. Audit findings are in the PR body but marker comments still can't be posted from this container (no gh CLI, GitHub API blocked by network policy).
- This session is subscribed to #1009 activity with an hourly self check-in monitor.

## Next step
- From a gh-capable session, in order:
  1. Re-run d091-reviewer + pre-pr-reviewer on PR #1009 (markers post → check green → squash-merge, delete branch).
  2. Update-branch #993 → re-run both agents → merge; then #994 the same (serially — both touch db snapshots); then #1007 (re-audit only; no snapshot overlap).
  3. Delete merged branch `feature/712-personal-api-tokens`.

## Blocked on user
- Nothing (PR merge is blocked on the marker-comment re-run above, not on a decision).

## Open questions
- #1003: D-201 narrowing — reviewer scope and mechanism review (user chose to defer)
- #1008: theming sweep for remaining customer surfaces (deferred from PR #1009)
