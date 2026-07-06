# Session state — last updated 2026-07-06 23:25 UTC

## Just completed
- Process review of the audit-agent workflow → implemented as PR #1628 (merged, D-316 + D-317):
  - `d091-reviewer` + `pre-pr-reviewer` now run **in parallel, concurrent with CI**, launched immediately after `gh pr create` (supersedes D-270 ordering). Any diff-changing commit stales BOTH markers → re-run both.
  - PR-body `## Audit` block retired; hash-bound marker comments are the only gate. Agents post summary comments via new `scripts/post-audit-comment.sh` and return full findings to the invoking session.
  - Gate re-trigger is now explicit: comments don't fire `pull_request` events, so after both agents post, run `gh run rerun <run-id>` (command in `pr-workflow.md`). The dead `edited` trigger was removed.
  - Hash-recipe drift guard added inside `pr-audit-section-check.yml` (asserts the jq filter line in script and workflow match; fail-closed).
  - Check ownership de-duplicated (slop/TODO → pre-pr + lint; stub-shaped → d091) and agents skip gate-owned greppable forms, auditing indirection + new escape hatches instead.
  - d091-reviewer gained 6 patterns (now 19): Inngest side effects outside `step.run`, module-level serverless state, date-only handling, PII in logs, index coverage for new query shapes, grant-widening deltas.
  - Both agents support **local mode** (pre-PR report-only) for shift-left on high-risk diffs.
  - **D-317 model criteria** (operator ruling): risk triggers → Opus for BOTH agents; size-only → Opus for d091 only, bar raised to ≥20 files/≥1000 net lines. Re-runs Sonnet.
- Dogfooded the new flow on PR #1628 itself: three parallel audit rounds, all findings fixed in-branch, gate re-run, squash-merged as a4863ce9.
- Posted coordination comment on #1612: when the sweep executes it, fold the 6 new prompt patterns into the catalog/CLAUDE.md numbering alongside its #21–#26, and consider `check:*` gates for #21 (claim-before-send) and #25 (bounded queries).
- Removed the third-party vitals plugin's prompt-type Stop hook from its cached hooks.json (fired uselessly on every no-change turn; no supported per-hook disable exists). **A vitals plugin update will restore it — re-delete the Stop entry from `~/.claude/plugins/cache/vitals/vitals/<version>/hooks/hooks.json` if the noise returns.** Takes effect next session (hooks load at session start).

## In flight
- Nothing in flight — clean checkpoint. (This SESSION.md update is the only open PR.)

## Next step
- Run `/issue-sweep` when the operator invokes it (unchanged from prior session; D-315: the #1575–#1613 backlog goes THROUGH the sweep). Note for the sweep: #1612 now carries the coordination comment above, and the sweep's own finalization step was updated to the parallel-audit flow.

## Blocked on user
- Operator invoking `/issue-sweep` (their chosen route for the #1575–#1613 backlog, per D-315).

## Open questions
- First post-#1628 PRs will shake out the new audit flow on real application diffs (the dogfood PR had no `apps/**` surface); watch that the gate-rerun step isn't forgotten — it's the one manual-ish step left.
- Carried: RAG ship-stats backfill script (PR #1566) never dry-run against any DB; `signature_feature` curation path (#1565) deferred.
- Carried: Resend's exact pre-bounce retry window is unpublished — if the number ever matters, ask Resend support (noted in #1611).
- Untracked in repo (pre-existing, untouched): `specs/GroupLandingPage.zip`, `specs/design_handoff_group_landing/` (briefly swept into a commit by a `git add -A`, reverted next commit — nets to zero in dev).
