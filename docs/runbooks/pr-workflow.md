# PR audit workflow — hash-bound marker mechanics

CLAUDE.md ("Git, commits, pushes, and PRs") carries the ordered workflow and the model-selection rule. This runbook is the detail on *how the audit gate works* — read it when a PR is blocked on the audit check or you're unsure whether a change stales an existing audit.

## The gate

The `pr-audit-section-check` gate passes only when each agent has posted a marker comment whose `diff:<sha256>` matches the PR's current effective diff (sorted filename+patch pairs). Markers:

- `<!-- d091-audit:v1 diff:<hash> -->`
- `<!-- prepr-audit:v1 diff:<hash> -->`

Timestamps are irrelevant — only the hash match. The agents post these themselves via `scripts/post-audit-comment.sh` (which owns PR resolution, hash computation, and posting); **never post markers manually, and never hand-roll the hash.** The hash recipe lives in exactly two places — the script and the workflow — and they must stay byte-identical; if one changes, change the other in the same PR.

The comments are **summaries** (scope, finding one-liners, standalone `Status` line) — proof-of-run plus an at-a-glance digest. Full findings (snippets, fixes) are returned by each agent to the invoking session, which acts on them. There is **no PR-body `## Audit` block anymore** — nothing writes one, and nothing gates on it.

## What stales an audit (and what doesn't)

- **`update-branch` (or any merge that doesn't change the effective diff) never stales an audit** — same hash, existing comments stay valid. Don't re-run agents after update-branching a queued PR.
- **A diff-changing commit** (fix-commit, conflict-resolving merge) changes the hash and stales **both** markers → re-run both agents for fresh comments.

## Running the agents (in parallel, concurrent with CI)

The two agents are independent — neither reads the other's output. Launch **both in a single message (two Agent calls)** immediately after `gh pr create`, so they run concurrently with each other **and** with CI. Rationale: `pnpm verify` is required before every push and is a superset of most required CI jobs, so a post-push CI failure is rare (mostly infra/e2e flake); overlapping agent time with CI time saves the wall-clock of a full serial pass on every PR, and the worst case (CI forces a fix-commit → re-run agents) is no worse than the old flow.

- `d091-reviewer` — D-091 anti-pattern coverage (correctness/security patterns).
- `pre-pr-reviewer` — slop sweep, tests-for-intent, surgical-changes discipline, and the other CLAUDE.md rules outside D-091.

Each agent self-posts its hash-bound marker comment and returns its full report to you.

If either agent reports findings, or CI fails: fix, push, let CI go green, then **re-run both agents in parallel** — the diff changed, so both markers are stale. Fresh comments embed the new hash; stale ones are ignored by the check.

### Local mode (optional shift-left)

Both agents support a **local (pre-PR) review**: they produce and return the full report without posting anything. Use it on high-risk diffs (the Opus-trigger list below) to catch BLOCKERs before the push/CI/PR cycle. A PR-mode run is still required once the PR exists — local mode never satisfies the gate.

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

- Don't run the audit agents in PR mode before the PR exists — the posting script aborts with an error when `gh pr view` returns empty, which is correct. (Local mode is the sanctioned pre-PR path; it posts nothing.)
- Don't manually post the `<!-- d091-audit:v1 -->` / `<!-- prepr-audit:v1 -->` marker comments — let the agents do it via the script.
- Don't merge a PR with failing or pending checks.
- Don't bypass branch protection, force-push to `dev`/`main`/`release/*`, merge into `main`, or open/merge `release/*` PRs.
