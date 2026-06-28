# PR audit workflow — hash-bound marker mechanics

CLAUDE.md ("Git, commits, pushes, and PRs") carries the ordered workflow and the model-selection rule. This runbook is the detail on *how the audit gate works* — read it when a PR is blocked on the audit check or you're unsure whether a change stales an existing audit.

## The gate

The `pr-audit-section-check` gate passes only when each agent has posted a marker comment whose `diff:<sha256>` matches the PR's current effective diff (sorted filename+patch pairs). Markers:

- `<!-- d091-audit:v1 diff:<hash> -->`
- `<!-- prepr-audit:v1 diff:<hash> -->`

Timestamps are irrelevant — only the hash match. The agents post these themselves; **never post them manually.**

The PR-body `## Audit` block is **not** gated — `pre-pr-reviewer` writes it from both agents' findings, for the user to read. Don't hand-craft it; a missing/short/"TBD" body never blocks.

## What stales an audit (and what doesn't)

- **`update-branch` (or any merge that doesn't change the effective diff) never stales an audit** — same hash, existing comments stay valid. Don't re-run agents after update-branching a queued PR.
- **A diff-changing commit** (fix-commit, conflict-resolving merge) changes the hash → re-run the agents for fresh comments.
- **Editing the PR body re-triggers the check** (it listens for `edited`) — never push a no-op or empty commit to refresh it.

## Running the agents (order matters — run them LAST, after required CI is green)

1. `d091-reviewer` FIRST — D-091 anti-pattern coverage.
2. `pre-pr-reviewer` SECOND — slop sweep, tests-for-intent, surgical-changes discipline, and the other CLAUDE.md rules outside D-091. It reads d091's comment to build the combined `## Audit` body, so order matters.

Both agents resolve the PR number from the branch and self-post their hash-bound marker comments.

If either agent reports findings: fix them, push, **let CI go green again**, then re-run that agent. Its fresh comment embeds the new diff hash; the old comment's stale hash no longer matches and is ignored by the check. You do NOT touch the `## Audit` body by hand — the agent rewrites it.

## Model selection

Default is Sonnet. Override to Opus on the FIRST audit run (pass `model: "opus"` on the Agent tool call) when ANY of these apply:

- Diff ≥ 10 files OR ≥ 500 net-added lines.
- Diff includes a SQL migration (new tables, RLS policies, grants, column add/drop).
- Diff adds a net-new API route under `apps/*/src/app/api/`, a new Inngest function, or a cron handler.
- Diff includes webhook signature verification, idempotency rows, or state-machine transitions (`progressTo`, `transitionTo`, etc.).
- Diff adds a new service-role code path (page or route using the service-role client).

Re-runs after fix-commits use Sonnet, even if the original first-run used Opus — re-runs check known patterns, not new surface area. Exception: if the fix-commit itself introduced one of the triggers above (rare), use Opus again.

## Exemptions

The check is required to merge. **You cannot bypass it.** Two exemptions:

- **Dependabot PRs** — version bumps with no code logic.
- **Doc-only PRs** — every changed file matches `*.md`, `docs/**`, or `specs/**`. The audit check short-circuits to success, and the heavy workflows skip too: `e2e`/CodeQL don't trigger at all, and the required `deploy.yml` jobs + `Guards & Build` skip via a `detect-changes` gate (skipped required jobs report as passing). Don't run the audit agents on doc-only PRs — merge once the (fast) checks settle. A single non-doc file in the diff disqualifies the PR from the exemption.

## Hard rules

- Don't run the audit agents before the PR exists — they abort with an error when `gh pr view` returns empty, which is correct.
- Don't manually post the `<!-- d091-audit:v1 -->` / `<!-- prepr-audit:v1 -->` marker comments — let the agents do it.
- Don't merge a PR with failing or pending checks.
- Don't bypass branch protection, force-push to `dev`/`main`/`release/*`, merge into `main`, or open/merge `release/*` PRs.
