# Session triage

Triage is **manual** — it no longer runs automatically at session start. Run this sweep when the user asks for it (e.g. "run triage", "triage open issues/PRs", or `/triage`). Goal: surface anything the user would otherwise have to ask about, and silently fix anything that doesn't need judgement.

When you finish, post the state-summary blocks at the bottom of this file.

## Open issues

Enumerate open GitHub issues:

```bash
gh issue list --state open --json number,title,labels,createdAt
```

For each issue:

- **`nightly-failure` label** — read the failing test names. If a single test failure is clearly fixable from the diff history (e.g. snapshot drift, fixture mismatch), open a fix branch + PR. Otherwise include in the state summary as "needs decision."
- **`regression-suspected` label** (from `dependabot-regression-detector`) — read the failure comment. If the regression is a known-broken transitive (e.g. vite 8 / vitest break), add a dependabot ignore + close. Otherwise surface as "needs your call."
- **Customer/tenant-reported bug labels** (`customer-reported`, `tenant-admin-reported`) — DON'T auto-fix. Surface in the state summary; the user routes these.
- **Any issue without a label** — DON'T auto-fix. Surface and ask.

**Assign a model label (`haiku`, `sonnet`, or `opus`) to every agent-doable engineering issue.** Any issue that an agent can implement without human judgement — i.e. NOT `customer-reported` / `tenant-admin-reported`, and NOT an unlabeled issue that needs routing — gets exactly one model label added with `gh issue edit <n> --add-label <tier>`. The label marks which model should pick the work up; it does not mean "fix it now." Escalate on **risk category, not diff size** (D-314 — Sonnet 5 handles large mechanical diffs; the old ≥10-files/≥500-lines size trigger no longer escalates execution). Apply `opus` when ANY of these hold:

- It involves a SQL migration (new tables, RLS policies, grants, column add/drop).
- It adds a net-new API route under `apps/*/src/app/api/`, a new Inngest function, or a cron handler.
- It touches webhook signature verification, idempotency rows, or state-machine transitions.
- It adds a new service-role code path.
- It touches permission-matrix or auth-adjacent logic.

Apply `haiku` when ALL of these hold: single file, no control-flow change — docs, typos, copy, config values, label/metadata chores.

Otherwise apply `sonnet` — the default, including large multi-file mechanical work. When scope can't be estimated from the issue text, default to `opus` and say so in the state summary. Do NOT add a model label to issues that need a human (customer/tenant-reported, or unlabeled-and-needs-routing) — those are surfaced, not labeled. If an issue already carries a model label, leave it unless its scope has clearly changed. Note: the PR-**audit** model selection in `pr-workflow.md` is a separate heuristic and still uses diff size — this section only governs which model executes the fix.

Fix-PRs opened during triage carry the `auto-triaged` label and a comment referencing the source issue.

## Open PRs

Enumerate open PRs:

```bash
gh pr list --state open --json number,title,mergeStateStatus,author,headRefName,labels,updatedAt
```

For each PR, classify:

- **MERGEABLE + CLEAN + all required checks green** → merge (squash) and delete branch. No judgement needed.
- **MERGEABLE + BEHIND** → `gh pr update-branch`. Re-check in next pass.
- **MERGEABLE + UNSTABLE (only non-required checks failing)** → merge if the PR is yours (Claude-authored) AND was opened in a prior session AND no `regression-suspected` label. Surface otherwise.
- **DIRTY (merge conflict)** — if the conflict is one we know how to resolve (event-registry additions, ai-batch-flush additions, route registrations, service-role-allowlist.js additions — additive lists), attempt a rebase + push. Otherwise surface as "needs your call."
- **BLOCKED on missing audit section** — if Claude-authored, run the audit subagents + edit the PR body (the check re-runs automatically on body edits). If human-authored, surface.
- **Failing CI on dependabot PRs** — let the `dependabot-retry-ci` workflow handle. Don't intervene.
- **Failing CI with the `regression-suspected` label** — triage.
- **Open > 7 days with no progress AND no `regression-suspected` label** — surface for triage; ask whether to close or push forward.

## Security & quality alerts

After the issue/PR sweep, pull the three GitHub security surfaces and the Supabase advisors:

```bash
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh api "repos/$repo/dependabot/alerts?state=open&per_page=100"
gh api "repos/$repo/code-scanning/alerts?state=open&per_page=100"
gh api "repos/$repo/secret-scanning/alerts?state=open&per_page=100"
```

Posture is **auto-fix the safe, surface the rest** — the same philosophy as the issue/PR rules above.

- **Dependabot — auto-fix when safe.** For an alert with a patched version, open a bump PR; for a transitive dep, prefer a **bounded** `overrides` entry in `pnpm-workspace.yaml` (pnpm 11 does NOT read `pnpm.overrides` from `package.json`) held *within the advisory's patched major* — never an unbounded `>=`, which pulls a surprise major bump. **First confirm the alert reflects what the app actually builds:** alerts on a stale or secondary lockfile (e.g. a stray root `package-lock.json` in this pnpm repo) are phantom — fix/remove the lockfile, don't bump. Group by package; one change can clear many alerts. Dev-tooling bumps with known break-risk (vite/vitest/esbuild — see MEMORY) still get a PR, but flagged "verify carefully," never blind-merged.
- **Code scanning — triage by location.** Findings in production app code (`apps/*/src/**`, not tests/fixtures/scripts) → open a fix PR, and pin the new security behavior with a test (a sanitizer that can't fail a test will silently regress). Findings in test files, fixtures, or dev-only scripts → dismiss with a reason (`used in tests` / `won't fix`) and a one-line comment. **Never dismiss a finding in shipped code without fixing it.**
- **Secret scanning — verify before alarm, never echo.** Decode/inspect the flagged value (mask it in any output). A real production credential (service-role JWT with a prod project `ref`, a live Stripe/Supabase key) → **STOP and surface for rotation**; do NOT auto-dismiss. A local-dev key (e.g. `iss=*-local`, no prod ref), a test fixture, or a mislabeled detector hit → resolve as `used_in_tests` / `false_positive` with an explaining comment.
- **Supabase advisors (`get_advisors` security + performance, both projects) — surface, don't auto-fix.** Every remediation touches the prod DB, which the "no prod deploys without asking" rule gates. RLS-enabled-no-policy on a service-role-only table is safe-by-design (deny-all) — note and move on. `SECURITY DEFINER` RPC exposure, disabled leaked-password protection, extension-in-public, etc. → surface for the operator's call.

## What triage MUST NOT do

- Don't merge PRs whose only blocker is a real test/typecheck failure on the application surface (those need investigation).
- Don't override branch protection or skip required checks.
- Don't run `gh pr update-branch` on a PR more than once per session — repeated update-branches with no other changes are wasted CI cycles.
- Don't auto-dismiss a secret-scanning alert without first decoding/verifying it is NOT a live production credential — and never paste the secret value into chat or a comment.
- Don't bump a dependency to satisfy a Dependabot alert that lives on a stale/unused lockfile — remove the lockfile instead.

## Output format

After the sweep, report:

```
Triage:
- Merged: #X, #Y
- Update-branched: #Z
- Opened fix PR for issue #N (auto-triaged)
- Labeled for model: #A (opus), #B (sonnet)
- Needs your call:
  - PR #M — <one line: what's blocking, what I'd do if I knew the answer>
  - Issue #P — <one line: why I can't auto-fix>
- Skipped (waiting on workflow): #Q (dependabot, retry workflow handles)
Security alerts:
- Dependabot: <open count> (auto-fixed in PR #R / phantom-lockfile / surfaced)
- Code scanning: <open count> (fixed #S, dismissed N test/script)
- Secret scanning: <open count> (dismissed N false-positive / SURFACED for rotation)
- Supabase advisors: <N security / N perf> surfaced
```

If nothing needed action: `Triage: clean — nothing open needed attention.` and `Security alerts: clean.`
