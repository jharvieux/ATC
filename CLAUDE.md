# CLAUDE.md — AI Travel Concierge

Working instructions for Claude Code sessions in this repo. Read this first, every session, before doing anything else.

> **Branch protection — read before you commit.** `dev` and `main` are protected. Never commit directly to either. **Every change lands via a PR into `dev`** — that includes edits to this file, MEMORY/SESSION, docs, and workflow YAML, not just application code. Branch off `dev` (`feature/*` or `docs/*`), push, open the PR, let required CI pass, then squash-merge. Full rules in "Git, commits, pushes, and PRs" below.

-----

## Session start protocol

Every session, in this order:

1. Read `/MEMORY-INDEX.md` (one line per decision, newest first). Do NOT read `/MEMORY.md` in full — it's the append-only archive; `grep` the full entry out of it when a task touches that area.
2. Read `/SESSION.md` in full.
3. If a build prompt is being executed, read it.
4. **Auto-triage open issues + PRs** per the rules in "Auto-triage on session start" below.
5. State in one short paragraph: what you understand the current state to be, what auto-triage did and found, and what you’re about to do.
6. Wait for the user to confirm or correct before acting on anything that needed a judgement call.

Step 5 is cheap and prevents expensive misreads of context.

-----

## Auto-triage on session start

After reading MEMORY/SESSION, run the auto-triage sweep. Goal: surface anything the user would otherwise have to ask about, and silently fix anything that doesn’t need judgement.

### Open issues

Enumerate open GitHub issues:

```bash
gh issue list --state open --json number,title,labels,createdAt
```

For each issue:

- **`nightly-failure` label** — read the failing test names. If a single test failure is clearly fixable from the diff history (e.g. snapshot drift, fixture mismatch), open a fix branch + PR. Otherwise include in the state summary as "needs decision."
- **`regression-suspected` label** (from `dependabot-regression-detector`) — read the failure comment. If the regression is a known-broken transitive (e.g. vite 8 / vitest break), add a dependabot ignore + close. Otherwise surface as "needs your call."
- **Customer/tenant-reported bug labels** (`customer-reported`, `tenant-admin-reported`) — DON'T auto-fix. Surface in the state summary; the user routes these.
- **Any issue without a label** — DON'T auto-fix. Surface and ask.

**Assign a model label (`opus` or `sonnet`) to every agent-doable engineering issue.** Any issue that an agent can implement without human judgement — i.e. NOT `customer-reported` / `tenant-admin-reported`, and NOT an unlabeled issue that needs routing — gets exactly one model label added with `gh issue edit <n> --add-label opus` (or `--add-label sonnet`). The label marks which model should pick the work up; it does not mean "fix it now." Choose with the same complexity heuristic as the PR-audit model selection below — apply `opus` when ANY of these hold:

- The expected fix touches ≥ 10 files OR ≥ 500 net-added lines.
- It involves a SQL migration (new tables, RLS policies, grants, column add/drop).
- It adds a net-new API route under `apps/*/src/app/api/`, a new Inngest function, or a cron handler.
- It touches webhook signature verification, idempotency rows, or state-machine transitions.
- It adds a new service-role code path.

Otherwise apply `sonnet`. When scope can't be estimated from the issue text, default to `opus` and say so in the state summary. Do NOT add a model label to issues that need a human (customer/tenant-reported, or unlabeled-and-needs-routing) — those are surfaced, not labeled. If an issue already carries an `opus`/`sonnet` label, leave it unless its scope has clearly changed.

Fix-PRs opened during auto-triage carry the `auto-triaged` label and a comment referencing the source issue.

### Open PRs

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

### Security & quality alerts

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

Add a `Security alerts:` block to the state summary: open counts per surface, what was auto-fixed/dismissed, and what needs a call. If all clean: `Security alerts: clean.`

### What auto-triage MUST NOT do

- Don't merge PRs whose only blocker is a real test/typecheck failure on the application surface (those need investigation).
- Don't override branch protection or skip required checks.
- Don't run `gh pr update-branch` on a PR more than once per session — repeated update-branches with no other changes are wasted CI cycles.
- Don't auto-dismiss a secret-scanning alert without first decoding/verifying it is NOT a live production credential — and never paste the secret value into chat or a comment.
- Don't bump a dependency to satisfy a Dependabot alert that lives on a stale/unused lockfile — remove the lockfile instead.

### Output format in the state summary

After auto-triage, the state summary (step 5 above) MUST include:

```
Auto-triage:
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

If nothing needed action, the line is `Auto-triage: clean — nothing open needed attention.` and `Security alerts: clean.`

-----

## MEMORY.md — the decision log

`/MEMORY.md` records every significant decision with rationale and what was rejected.

- Newest entries on top.
- Each entry: date, decision, why, what was rejected, related artifacts.
- After any significant decision this session, **add an entry**. Significant means anything a future engineer or the user re-reading the log would want to know — model choices, threshold values, file-structure decisions, sequencing, scope cuts, deferrals.
- **You can add entries. You cannot edit prior entries** without explicit permission — they are the historical record.
- **`MEMORY.md` is the archive; `MEMORY-INDEX.md` is the session-start read.** Never read `MEMORY.md` in full (it's ~120K tokens). When you prepend an entry here, also prepend its one-liner under `## Entries` in `MEMORY-INDEX.md`, or rerun the rebuild snippet in that file's header.
- If a user request conflicts with a logged decision, stop and surface the conflict before proceeding.

### How to write to it (a hook enforces append-only)

A PreToolUse hook (`.claude/hooks/block-spec-memory-edits.mjs`) rejects any MEMORY.md change that isn't a pure prepend, and **fails closed** — a malformed edit is blocked, not silently allowed. This is what trips up naive edits. Two ways to satisfy it:

- **Edit (preferred — surgical):** the hook's rule is literally `new_string` must *end with* `old_string`. So anchor on the **current newest entry's header line** (it's unique) and repeat that line verbatim at the *end* of `new_string`:
  - `old_string` → `## D-113 — 2026-05-29 — <title>` (whatever the top entry happens to be right now)
  - `new_string` → `## D-114 — <today> — <title>\n\n<body>\n\n---\n\n## D-113 — 2026-05-29 — <title>`
  - The new entry lands above the anchor; the anchor survives as the suffix, so the `endsWith` check passes. Pick the anchor line so it's unique in the file (the full header is) — the Edit tool also requires `old_string` to be unique.
- **Write (whole-file fallback):** the new content must *end with* the entire current file verbatim (trailing whitespace aside). Read the file first, then write `<new entry>\n\n---\n\n<entire current content>`. Bigger payload, more truncation risk — prefer Edit.

Do not reword or replace a prior entry — the hook blocks it and the rule above forbids it. If you truly must, ask the user for explicit permission first.

-----

## SESSION.md — resume state

`/SESSION.md` is the working state file. It lets the next session pick up cleanly after a token-limit or 5-hour-window break.

Update SESSION.md:

- At the end of every session.
- Before any long-running operation that might exhaust tokens mid-task.
- After completing a meaningful chunk of work, even mid-session.

Required fields (overwrite the file each time — no history):

```markdown
# Session state — last updated YYYY-MM-DD HH:MM TZ

## Just completed
- bullet list of what was finished this session

## In flight
- task name, file paths involved, current state (uncommitted? on branch X?)
- if nothing in flight, write "Nothing in flight — clean checkpoint"

## Next step
- the literal next thing to do when work resumes

## Blocked on user
- anything waiting for a user decision or external action
- if nothing, write "Nothing"

## Open questions
- anything you noticed but didn't act on
```

At session start, read SESSION.md and resume from “Next step” unless the user redirects.

**Writing it is a plain whole-file overwrite — no hook, no prepend rule (the opposite of MEMORY.md).** Use the Write tool to replace the file with the fields above, freshly filled in. Don't try to preserve or prepend prior state: SESSION.md is transient working state, not history, so last-write-wins is correct.

-----

## End-of-session protocol

Triggered by any of:

- The user signals end of session (“we’re done,” “stop here,” “log off,” etc.).
- You estimate you are approaching the context window limit.
- A long-running operation is about to start that might not finish in remaining context.

Steps, in order:

1. **Never leave the repo broken.** If there are uncommitted changes, ensure they typecheck and don’t break the build. If they don’t, either fix them or stash them on a WIP branch — don’t leave broken code on a working branch.
1. **Slop sweep** (D-091). Before committing, re-read your own diff with an explicit anti-slop lens. Delete:
   - Comments that explain WHAT the code does (delete unless they explain WHY).
   - Helper functions called only once (inline at the call site).
   - try/catch blocks that just re-throw or swallow (let the error propagate).
   - JSDoc paragraphs on simple functions (one-line max).
   - TODOs without an owner or issue ref (rewrite as `TODO(owner)` or `TODO(#123)` — `atc/no-orphan-todo` enforces this).
   - Defensive validation for inputs that can't actually be invalid (trust internal code).

   Optionally run `pnpm slop-check` against the current diff for a mechanical scan.
1. Commit any uncommitted work with a descriptive message.
1. Push to the remote.
1. Update SESSION.md with the current state.
1. Add any MEMORY.md entries for decisions made this session.
1. If you switched to Opus or Haiku at any point, switch back to Sonnet: `/model claude-sonnet-4-6`.
1. State briefly what was done and what’s next.

-----

## The user

Technically fluent across IT (network/systems administration, vendor management, leading dev/QA, requirements, cloud deployments) but **does not write code and will not review code**. Do not ask the user to read diffs, evaluate code quality, or pick between code-level alternatives.

Do ask the user about:

- Product/feature behavior
- Trade-offs framed in plain-English outcomes (cost, risk, latency, complexity)
- Scope and sequencing
- Model selection when uncertain
- Anything that touches MEMORY.md

-----

 — Think Before Coding
State assumptions explicitly. If uncertain, ask rather than guess.
Present multiple interpretations when ambiguity exists.
Push back when a simpler approach exists.
Stop when confused. Name what's unclear.

— Simplicity First
Minimum code that solves the problem. Nothing speculative.
No features beyond what was asked. No abstractions for single-use code.
Test: would a senior engineer say this is overcomplicated? If yes, simplify.

 — Surgical Changes

Don't refactor what isn't broken. Match existing style.

— Never ignore a bug you find
If you encounter a bug while doing other work, you must act on it — never leave it noted and unfixed.
- **Trivial** (one-liner fix, obvious cause, no scope risk): fix it inline in your current PR. Note it in the commit message.
- **Non-trivial** (requires investigation, touches multiple files, or has unclear blast radius): open a GitHub issue before the end of the session. Include: what the bug is, where it lives, what the symptom is, and what the likely fix looks like. Reference the issue in SESSION.md under "Open questions" or "Blocked on user" as appropriate.

"I'll track it as a follow-up" is only acceptable if the GitHub issue exists by the end of the session. Leaving a known bug untracked is not acceptable.

— Every follow-up or deferral gets a GitHub issue
The same "issue or it didn't happen" rule applies to anything you deliberately defer — not just bugs. If during a PR you decide to ship X without Y (image optimization left as a follow-up, DB schema cleanup deferred, a test gap noted by the reviewer, a known incomplete UX variant, a known performance opportunity), open a GitHub issue **before the PR merges**. Reference the issue from the PR body's "Follow-ups" or "Not in scope" section, and from MEMORY if the decision is significant.

Why: the PR's "deferred items" bullets get forgotten the moment the PR closes. A MEMORY note is queryable by another agent but not by the user from the GitHub UI. The issue is the durable handle the user needs to ask "what's outstanding here?" without re-reading every PR description.

Applies to:
- Things you explicitly chose to defer ("X is a follow-up")
- Audit findings you addressed by changing scope rather than fixing
- Known gaps surfaced by reviewers but intentionally left in
- Performance / asset / cleanup items noted in PR descriptions
- "We should also..." items raised but not built this round

The acceptance bar is *not* "issue exists" — it's "issue is specific enough that someone returning cold could pick it up." Include: what the problem is, where it lives (file paths), what the acceptance criteria are, and why it was deferred.

 — Goal-Driven Execution
Define success criteria. Loop until verified.
Don't follow steps. Define success and iterate.
Strong success criteria let you loop independently.

 — Use the model only for judgment calls
Use me for: classification, drafting, summarization, extraction.
Do NOT use me for: routing, retries, deterministic transforms.
If code can answer, code answers.

— Tests verify intent, not just behavior
Tests must encode WHY behavior matters, not just WHAT it does.
A test that can't fail when business logic changes is wrong.

 — Checkpoint after every significant step
Summarize what was done, what's verified, what's left.
Don't continue from a state you can't describe back.
If you lose track, stop and restate.

 — Match the codebase's conventions, even if you disagree
Conformance > taste inside the codebase.
If you genuinely think a convention is harmful, surface it. Don't fork silently.

— Fail loud
"Completed" is wrong if anything was skipped silently.
"Tests pass" is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.

— D-091 anti-patterns (authoring checklist)
Full catalog — symptoms, examples, codebase instances, prevention — lives in
`docs/runbooks/anti-patterns.md`. Scan this list before writing app code; the
`d091-reviewer` agent enforces it at PR time. The actionable specifics are kept
here so the doctrine is in-context every session; open the runbook for the why.

1. **No stub-shaped code** — every parameter must affect output; every returned variant reachable; no dead `if/else` branches. A `kid` arg that resolves to one key is worse than no arg.
2. **Fail-closed** — when an enforcement layer can't run (Redis/DB/secret/signature absent), deny, don't permit. Returning `{ allowed: true }` on error, or 200 on a silent write failure, is the worst mode — silent AND it kills retries.
3. **Check every Supabase mutation** — supabase-js v2 doesn't throw. Wrap with `safeAwait(...)` or destructure `{ error }` and return non-200. CAS updates use `safeAwaitRowCount` with the expected count. Helpers: `apps/main/src/lib/db/safe-mutation.ts`.
4. **Two layers of tenant isolation** — app-layer filter AND DB-layer constraint (RLS via `tenantClient`, or explicit `.eq("tenant_id", …)` on service-role queries). One defense is one bug from cross-tenant leakage.
5. **Credentials in headers, never URLs** — `Authorization: Bearer …`, not `?token=…`. URLs leak into proxy/CDN/APM logs and `TypeError` messages; headers are scrubbed.
6. **Quota gates re-read between consuming ops** — re-check between batches, or use a DB-atomic reserve-row. A gate read once before a loop misses mid-loop overruns; concurrent crons double-spend.
7. **CAS status-guarded updates verify row count** — `.update(...).eq("status", 'Y')` returns `{ error: null }` even on zero matched rows. Chain `.select('id')` and assert the affected-row count.
8. **No unjustified `void` async in serverless** — the host can kill the process before fire-and-forget work completes. `await` it, or add `// allow-void-async: <reason>` (must be idempotent/retry-safe).
9. **One assertPermission per semantic operation** — routes switching on `body.action` or multiple HTTP methods need a separate gate per (resource, action). Reusing one gate is over- or under-permissive.
10. **Idempotency rows written AFTER dispatch** — the dedup row must mean "fully processed," not "received," or a crash mid-handler strands the work behind a duplicate-rejection. Use a separate `processing_started_at` for in-flight tracking.
11. **State-machine transitions validate at the function boundary** — `progressTo`/`revertTo`/`transitionTo` must assert the target is enum-valid and the transition is permitted from current state. Don't trust callers (e.g. `body.target_stage`).
12. **Webhook signatures: capture the encoding at integration time** — hex vs base64 vs base64url. Mis-decoding silently rejects every valid webhook. Add a recorded-signature fixture test and a comment naming the provider + encoding.
13. **Destructive migrations ship AFTER the read-switchover, in their own PR** (#137) — expand → switch reads → contract as THREE separate merges. Column names are query-string literals tsc can't see. Never bundle the contract drop with the expand or read-switch. `pnpm check:dropped-columns` ("Dropped-column reader guard") is the backstop.
14. **Permission grants belong with the route PR** (#1173) — adding a route that calls `assertPermission` requires, in the SAME PR, the `key("resource","action")` entry in `apps/main/src/lib/auth/permission-grants.ts` AND the matching tuple in `permission-grants.test.ts`. `pnpm check:permission-matrix` ("Permission-matrix guard") enforces it; pre-existing gaps live in `scripts/permission-matrix-baseline.txt`.
15. **Every admin route asserts platform-admin in the handler** (#1393/G5) — the `proxy.ts` admin gate is only a cookie *shape* check; real authority is the per-route assertion. Any new `app/api/admin/**/route.ts` must call an authority gate in-handler (main: `assertPlatformAdmin*` / `MAIN_APP_ADMIN_API_KEY` constant-time compare; rag: a `service_identifier === "platform-admin"` check). `pnpm check:admin-auth` ("Admin-route auth guard") enforces that an authority token is *present* (it's a presence check, not flow analysis); intentional exemptions live in `scripts/admin-route-auth-baseline.txt`. Separately, mutating rag admin routes must also gate `scope === "write"` (convention, not enforced by this guard — see F-rag-auth-02).

## Honesty about uncertainty

**Never present a guess as a fact.** If uncertain about a fact, statistic, date, quote, API behavior, library version, or anything else, say so explicitly *before* the uncertain claim. “I’m not certain about this, but…” is always better than confident wrong.  If unsure about what was in the spec re-read that section before assuming anything.

Do not fill gaps with plausible-sounding information. If you don’t know, say you don’t know and propose how to find out (read a file, run a command, search the docs, ask the user).

Applies especially to:

- Library/API behavior you haven’t verified in this session
- Version-specific syntax (Next.js, Supabase, Vercel CLI, GitHub Actions)
- What’s in spec files you haven’t read or only skimmed in this session — read them, don’t guess
- Anything where being wrong would cost the user real time or money

-----

## Show options before acting when unsure

When facing a choice with non-obvious trade-offs, **present the options before acting.** Don’t pick silently. Format:

- Brief description of the choice
- 2–4 labeled options, each with the trade-off in one line
- Your recommendation and why
- Stop and wait for the user’s call

Exceptions where you can proceed without asking:

- The choice is purely mechanical (formatting, naming convention already established)
- The build prompt or spec already specifies the answer
- The user has already given a standing instruction covering this case (check MEMORY.md)

When in doubt, ask. The user prefers an extra question over an unwanted change.


## Git, commits, pushes, and PRs

**You have full autonomy for commits and pushes.** Commit and push whenever it makes sense — at logical work boundaries, before risky operations, at end of session, after each completed file or task chunk.

### Commit messages

- Imperative mood, short summary line (≤72 chars), then optional body.
- Reference the build prompt section or issue if applicable (`§4: add deploy.yml workflow`).
- If commit closes work in flight from a prior session, note it.

### Branches

- Feature work goes on `feature/<short-name>` branches off `dev`.
- Never commit directly to `dev` — always via PR.
- Never commit directly to `main` ever. `main` is updated only by the production pipeline’s auto-merge step.
- Never auto-merge `release/*` branches anywhere. Release branches go through the manual approval gate in the CI/CD pipeline. You may push to `release/*` if executing a release task, but the pipeline owns promotion.

### Before every push

Run `pnpm verify` (full: typecheck + lint + tests + slop-check) before `git push`. The Stop hook covers turn-end pushes; mid-session pushes bypass it. CI catches everything `pnpm verify` would catch, but each CI run costs minutes and creates noise on failing PRs. Running locally first surfaces breaks while you still have the context to fix them cleanly.

The rule is mandatory for application-code PRs. For PRs touching only docs, workflow YAML, or other non-code files, `pnpm verify` is fast (most steps are no-ops on those files) — still run it.

If `pnpm verify` fails, fix and re-verify before pushing. If a failure is pre-existing on dev (not caused by your branch), call it out to the user and don't block.

### Pull requests

**You can open and merge PRs into `dev`** under these conditions:

1. All required CI status checks pass.
1. The work is complete (not a WIP).
1. The merge isn’t into a protected release branch.

**Mandatory hash-bound audit comments on every PR.**

The `pr-audit-section-check` gate passes only when each agent has posted a marker comment whose `diff:<sha256>` matches the PR's current effective diff (sorted filename+patch pairs). Markers: `<!-- d091-audit:v1 diff:<hash> -->` and `<!-- prepr-audit:v1 diff:<hash> -->`. Timestamps are irrelevant. The agents post these themselves — never post them manually.

The PR-body `## Audit` block is **not** gated — `pre-pr-reviewer` writes it from both agents' findings, for the user to read. Don't hand-craft it; a missing/short/"TBD" body never blocks.

In practice:

- **`update-branch` (or any merge that doesn't change the effective diff) never stales an audit** — same hash, existing comments stay valid. Don't re-run agents after update-branching a queued PR.
- **A diff-changing commit** (fix-commit, conflict-resolving merge) changes the hash — re-run the agents for fresh comments.
- **Editing the PR body re-triggers the check** (it listens for `edited`) — never push a no-op or empty commit to refresh it.

**Workflow (order matters). Run the agents LAST — after required CI is green:**

1. `pnpm verify` passes — clean typecheck, lint, tests, slop-check.
2. Push the branch.
3. **Open the PR** (`gh pr create`). No `## Audit` block needed — `pre-pr-reviewer` writes it.
4. **Wait for the required CI checks to go green** (`Typecheck`, `Lint`, `Test`, `Guards & Build`, the security/contract jobs). If any fail, fix + push and let them re-run. Get CI clean BEFORE running the agents — this is the key change: it stops an unrelated lint/type fix from re-staling the audit and forcing a second full agent run.
5. **Then run both audit agents** (they resolve the PR number from the branch, self-post their hash-bound marker comments, and `pre-pr-reviewer` writes the `## Audit` body):
   - Invoke `d091-reviewer` FIRST for D-091 anti-pattern coverage.
   - Then invoke `pre-pr-reviewer` for slop sweep, tests-for-intent, surgical-changes discipline, and the other CLAUDE.md rules outside D-091. (It reads d091's comment to build the combined body, so order matters.)

   **Model selection.** Default is Sonnet. Override to Opus on the FIRST audit run (pass `model: "opus"` on the Agent tool call) when ANY of these apply:
   - Diff ≥ 10 files OR ≥ 500 net-added lines.
   - Diff includes a SQL migration (new tables, RLS policies, grants, column add/drop).
   - Diff adds a net-new API route under `apps/*/src/app/api/`, a new Inngest function, or a cron handler.
   - Diff includes webhook signature verification, idempotency rows, or state-machine transitions (`progressTo`, `transitionTo`, etc.).
   - Diff adds a new service-role code path (page or route using the service-role client).

   Re-runs after fix-commits use Sonnet, even if the original first-run used Opus — re-runs are checking known patterns, not exploring new surface area. Exception: if the fix-commit itself introduced one of the triggers above (rare), use Opus again.

6. If either agent reports findings, fix them, push, **let CI go green again**, then re-run that agent (its fresh comment embeds the new diff hash; the old comment's stale hash no longer matches and is ignored by the check). You do NOT touch the `## Audit` body by hand — the agent rewrites it.
7. Once all checks pass, merge (squash merge by default). Delete the feature branch after merge.

The check is required to merge. **You cannot bypass it.** Two exemptions:

- **Dependabot PRs** — version bumps with no code logic.
- **Doc-only PRs** — every changed file matches `*.md`, `docs/**`, or `specs/**`. The audit check short-circuits to success, and the heavy workflows now skip too: `e2e`/CodeQL don't trigger at all, and the required `deploy.yml` jobs + `Guards & Build` skip via a `detect-changes` gate (skipped required jobs report as passing). Don't run the audit agents on doc-only PRs — merge once the (fast) checks settle. A single non-doc file in the diff disqualifies the PR from the exemption.

**You may NOT:**

- Run the audit agents before the PR exists — they abort with an error when `gh pr view` returns empty, which is correct.
- Manually post the `<!-- d091-audit:v1 -->` or `<!-- prepr-audit:v1 -->` marker comments — let the agents do it.
- Merge a PR with failing or pending checks.
- Bypass branch protection rules.
- Force-push to `dev`, `main`, or `release/*`.
- Merge PRs into `main` (only the production pipeline does this).
- Open or merge `release/*` PRs — that’s the user’s call and the pipeline’s job.

-----

## Build prompts and sequencing

The CI/CD implementation prompts are in `ATC_CICD_Implementation___Build_Prompts_for_Claude_Code.md`. Each section is self-contained: manual prerequisites → invocation → prompt → verification → manual follow-ups.



-----

## File and directory conventions

- **Specs** (read-only source of truth, `.html`): 
Separate .html file for each section of the spec.
. Never modify. If a build prompt disagrees with a spec, the spec wins — flag and stop.
- **Build prompts** (`.md`): execution instructions. Don’t modify unless the user explicitly asks for a build-prompt edit.
- **Decision log:** `/MEMORY.md` (repo root, uppercase).
- **Session state:** `/SESSION.md` (repo root, uppercase).
- **Project docs you create:** `/docs/` (repo root). Organize by concern — `/docs/evals/`, `/docs/testing/`, `/docs/cicd/`, `/docs/runbooks/`. Markdown, lowercase, hyphenated filenames.
- **Help docs (customer-facing):** `apps/main/content/help/` — see Help Docs build prompts for authoring standards.
- **Workflow files:** `.github/workflows/`.
- **Database / SQL:** `scripts/` for one-shot scripts (`staging-fixups.sql`), `db/` for migrations and snapshots (`db/rls-snapshot.sql`).

When creating a doc the user will refer to later (design proposals, runbooks, postmortems), default to `/docs/<area>/<topic>.md` unless the user specifies otherwise.

-----

## Working with the specs

The v6 spec and the CI/CD pipeline spec together are the source of truth.

- **Read relevant sections before writing code or docs.** Don’t paraphrase from memory.
- Cross-references in specs use `§N.M` notation. Follow them.
- **If a spec is ambiguous,** flag it, propose an interpretation, ask the user to confirm. Don’t invent behavior.
- **If a spec is wrong,** flag it. Don’t silently work around it. Update the spec (with user approval) so the next reader gets the corrected version.

-----

## Things to never do without explicit permission

- Delete files or branches (except your own feature branches after merging the PR they were for)
- Rename files
- Restructure directories
- Modify spec `.html` files
- Modify build prompt `.md` files
- Edit prior MEMORY.md entries (additions only)
- Merge into `main` or `release/*`
- Force-push anywhere
- Install new runtime dependencies (dev-dependencies are OK if obviously needed for a task)

- Disable or bypass branch protection
- Disable CI checks

-----

## Things you can do freely

- Read any file in the repo
- Run typecheck, lint, tests, build locally
- Create new files in `/docs/`, `scripts/`, `tests/`, `.github/workflows/` (per build prompts)
- Add new entries to `MEMORY.md`
- Overwrite `SESSION.md` (it’s transient state, not history)
- Commit and push to feature branches
- Open PRs into `dev`
- Merge PRs into `dev` when CI passes
- Delete your own feature branches after merge
- Switch models with `/model`
- Ask the user a clarifying question — always preferred over guessing

-----

## When you finish a task

- State what you did, briefly.
- Note any verification the user should run (UI checks, dashboards, deploys).
- Note any follow-ups flagged in the build prompt’s “Manual follow-ups” section.
- If a decision was made worth logging — write the MEMORY.md entry.

- Update SESSION.md.

Don’t pad the wrap-up. A few lines is enough.