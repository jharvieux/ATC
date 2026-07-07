# PR audit workflow — hash-bound marker mechanics

CLAUDE.md ("Git, commits, pushes, and PRs") carries the ordered workflow and the model-selection rule. This runbook is the detail on *how the audit gate works* — read it when a PR is blocked on the audit check or you're unsure whether a change stales an existing audit.

## The gate

The `pr-audit-section-check` gate passes only when each agent has posted a marker comment whose `diff:<sha256>` matches the PR's current effective diff (sorted filename+patch pairs). Markers:

- `<!-- d091-audit:v1 diff:<hash> -->`
- `<!-- prepr-audit:v1 diff:<hash> -->`

Timestamps are irrelevant — only the hash match. The agents post these themselves via `scripts/post-audit-comment.sh <pr-number> <marker-prefix> <report-file>` (which takes an **explicit PR number** — no ambient `gh pr view` / cwd-branch resolution — and cross-checks that PR's `headRefName` against the checked-out branch, refusing to post on any mismatch); **never post markers manually, and never hand-roll the hash.** The recipe's jq filter lives in exactly two places — the script and the workflow — and must stay byte-identical (a drift-guard step in the workflow enforces it); if one changes, change the other in the same PR. The hash-extraction tail after jq differs cosmetically between the two (Linux vs macOS tooling) but must keep producing the same hex.

The same script also has a **check-only mode**, `scripts/post-audit-comment.sh --check <pr-number>` — it computes the current hash and reports whether each posted marker prefix (`d091-audit:v1`, `prepr-audit:v1`) is current or stale, without posting anything. Use it before deciding whether to re-dispatch the audit agents (see "Merge trains" below) instead of eyeballing hashes.

The comments are **summaries** (scope, finding one-liners, standalone `Status` line) — proof-of-run plus an at-a-glance digest. Full findings (snippets, fixes) are returned by each agent to the invoking session, which acts on them. There is **no PR-body `## Audit` block anymore** — nothing writes one, and nothing gates on it.

## What stales an audit (and what doesn't)

- **`update-branch` (or any merge that doesn't change the effective diff) never stales an audit** — same hash, existing comments stay valid. Don't re-run agents after update-branching a queued PR.
- **A diff-changing commit** (fix-commit, conflict-resolving merge) changes the hash and stales **both** markers → re-run both agents for fresh comments.
- **`BEHIND` is harmless on its own.** A queued PR's effective diff (files API) is pinned to its existing merge-base until you actually update-branch it — dev moving underneath it does not touch the hash or stale its markers. There is nothing to do while a PR just sits `BEHIND`.
- **Same-file sibling overlap legitimately re-hashes.** If a merging sibling PR touches a file this PR also touches, update-branching genuinely changes this PR's diff content (not just line offsets) — that's a real re-audit, not waste (#1671 finding 2: a dev-merge once reintroduced a bug into a queued PR, and only the forced re-audit caught it).

## Merge trains (multiple PRs queued to merge in sequence)

Investigated in #1671 after a 20-PR sweep burned 2–5 audit-agent pairs per PR on avoidable re-audits. The gate's hash recipe was not the problem (verified stable across no-op merges) — the waste was purely orchestration behavior. Two rules:

1. **Update-branch a PR exactly once: immediately before merging it.** Never update-branch a queued PR proactively after every sibling merge — per the rule above, `BEHIND` isn't costing you anything, and each extra update-branch is a full required-CI re-run for no reason (`strict: true` on `dev` means every one is expensive).
2. **Process the queue strictly in sequence:** merge PR A → update-branch PR B (now picks up A's merge) → merge B → update-branch PR C → merge C → ... Don't update-branch all queued PRs upfront in a batch.
3. **After any branch update, check before you re-dispatch.** Don't reflexively re-run the audit agents just because a branch update happened. Run `scripts/post-audit-comment.sh --check <pr-number>` first — it recomputes the current diff hash (same recipe below) and reports whether each posted marker is still current. Only dispatch fresh agents on a reported "stale"; a "current" result means the update-branch didn't change the effective diff and the existing markers still satisfy the gate.

## Running the agents (in parallel, concurrent with CI)

The two agents are independent — neither reads the other's output. Launch **both in a single message (two Agent calls)** immediately after `gh pr create`, so they run concurrently with each other **and** with CI. Rationale: `pnpm verify` is required before every push and is a superset of most required CI jobs, so a post-push CI failure is rare (mostly infra/e2e flake); overlapping agent time with CI time saves the wall-clock of a full serial pass on every PR, and the worst case (CI forces a fix-commit → re-run agents) is no worse than the old flow.

- `d091-reviewer` — D-091 anti-pattern coverage (correctness/security patterns).
- `pre-pr-reviewer` — slop sweep, tests-for-intent, surgical-changes discipline, and the other CLAUDE.md rules outside D-091.

**Pass the PR number into each agent's prompt.** The invoking agent always knows it (it just ran `gh pr create`) — include it explicitly so the agent can pass it to `post-audit-comment.sh`. This matters most when running from a git worktree: the script no longer infers the PR from cwd branch state, so an explicit, correct PR number is the only thing that prevents a marker landing on the wrong PR.

Each agent self-posts its hash-bound marker comment and returns its full report to you.

If either agent reports findings, or CI fails: fix, push, let CI go green, then **re-run both agents in parallel** — the diff changed, so both markers are stale. Fresh comments embed the new hash; stale ones are ignored by the check.

### Re-triggering the gate after the agents post

Comments do **not** fire `pull_request` events, so the gate run that failed at PR-open (before any marker existed) stays red until re-run. After **both** agents report success, re-run it once:

```bash
gh run rerun "$(gh run list --workflow pr-audit-section-check.yml \
  --branch "$(git branch --show-current)" --limit 1 --json databaseId --jq '.[0].databaseId')"
```

(In the old flow, pre-pr-reviewer's PR-body edit re-triggered the check via the `edited` event; both the body edit and the `edited` trigger are retired.)

### Local mode (optional shift-left)

Both agents support a **local (pre-PR) review**: they produce and return the full report without posting anything. Use it on high-risk diffs (the Opus-trigger list below) to catch BLOCKERs before the push/CI/PR cycle. A PR-mode run is still required once the PR exists — local mode never satisfies the gate.

## Model selection

Default is Sonnet for both agents. Opus overrides apply to the FIRST audit run only (pass `model: "opus"` on the Agent tool call), **split by trigger type** (D-317):

**Risk triggers → Opus for BOTH agents.** On these diffs both reviewers' judgment-heavy checks (d091's blast radius, pre-pr's tests-for-intent and honesty-about-uncertainty) earn the stronger model — the agents are the only review bench, so don't thin it where the risk lives:

- Diff includes a SQL migration (new tables, RLS policies, grants, column add/drop).
- Diff adds a net-new API route under `apps/*/src/app/api/`, a new Inngest function, or a cron handler.
- Diff includes webhook signature verification, idempotency rows, or state-machine transitions (`progressTo`, `transitionTo`, etc.).
- Diff adds a new service-role code path (page or route using the service-role client).

**Size-only trigger → Opus for d091-reviewer only** (pre-pr stays Sonnet — its checks don't scale with diff size the way blast-radius tracking does):

- Diff ≥ 20 files OR ≥ 1000 net-added lines, with no risk trigger hit. (Raised from D-147's 10/500 for Sonnet 5.)

Re-runs after fix-commits use Sonnet for both, even if the original first-run used Opus — re-runs check known patterns, not new surface area. Exception: if the fix-commit itself introduced a risk trigger (rare), apply the rules above again.

## Exemptions

The check is required to merge. **You cannot bypass it.** Two exemptions:

- **Dependabot PRs** — version bumps with no code logic.
- **Doc-only PRs** — every changed file matches `*.md`, `docs/**`, or `specs/**`. The audit check short-circuits to success, and the heavy workflows skip too: `e2e`/CodeQL don't trigger at all, and the required `deploy.yml` jobs + `Guards & Build` skip via a `detect-changes` gate (skipped required jobs report as passing). Don't run the audit agents on doc-only PRs — merge once the (fast) checks settle. A single non-doc file in the diff disqualifies the PR from the exemption.

## Hard rules

- Don't run the audit agents in PR mode before the PR exists — the posting script aborts with an error when `gh pr view` returns empty, which is correct. (Local mode is the sanctioned pre-PR path; it posts nothing.)
- Don't manually post the `<!-- d091-audit:v1 -->` / `<!-- prepr-audit:v1 -->` marker comments — let the agents do it via the script.
- Don't merge a PR with failing or pending checks.
- Don't bypass branch protection, force-push to `dev`/`main`/`release/*`, merge into `main`, or open/merge `release/*` PRs.
