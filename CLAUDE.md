# CLAUDE.md — AI Travel Concierge

Working instructions for Claude Code sessions in this repo. Read this first, every session, before doing anything else.

-----

## Session start protocol

Every session, in this order:

1. Read `/MEMORY.md` in full.
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
- **DIRTY (merge conflict)** — if the conflict is one we know how to resolve (event-registry additions, ai-batch-flush additions, route registrations — additive lists), attempt a rebase + push. Otherwise surface as "needs your call."
- **BLOCKED on missing audit section** — if Claude-authored, run the audit subagents + edit the PR body + re-request the audit-check. If human-authored, surface.
- **Failing CI on dependabot PRs** — let the `dependabot-retry-ci` workflow handle. Don't intervene.
- **Failing CI with the `regression-suspected` label** — DON'T touch. Surface to user.
- **Open > 7 days with no progress AND no `regression-suspected` label** — surface for triage; ask whether to close or push forward.

### What auto-triage MUST NOT do

- Don't close issues without explicit user permission.
- Don't merge PRs whose only blocker is a real test/typecheck failure on the application surface (those need investigation).
- Don't override branch protection or skip required checks.
- Don't run `gh pr update-branch` on a PR more than once per session — repeated update-branches with no other changes are wasted CI cycles.

### Output format in the state summary

After auto-triage, the state summary (step 5 above) MUST include:

```
Auto-triage:
- Merged: #X, #Y
- Update-branched: #Z
- Opened fix PR for issue #N (auto-triaged)
- Needs your call:
  - PR #M — <one line: what's blocking, what I'd do if I knew the answer>
  - Issue #P — <one line: why I can't auto-fix>
- Skipped (waiting on workflow): #Q (dependabot, retry workflow handles)
```

If nothing needed action, the line is `Auto-triage: clean — nothing open needed attention.`

-----

## MEMORY.md — the decision log

`/MEMORY.md` records every significant decision with rationale and what was rejected.

- Newest entries on top.
- Each entry: date, decision, why, what was rejected, related artifacts.
- After any significant decision this session, **add an entry**. Significant means anything a future engineer or the user re-reading the log would want to know — model choices, threshold values, file-structure decisions, sequencing, scope cuts, deferrals.
- **You can add entries. You cannot edit prior entries** without explicit permission — they are the historical record.
- If a user request conflicts with a logged decision, stop and surface the conflict before proceeding.

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
Touch only what you must. Clean up only your own mess.
Don't "improve" adjacent code, comments, or formatting.
Don't refactor what isn't broken. Match existing style.

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

— No stub-shaped code (D-091)
If a function takes a parameter, every parameter must affect the output.
If a function returns a tuple, every variant must be reachable.
A `kid` arg that resolves to the same single key is worse than not having the arg —
the signature lies about the behavior. Same for `if/else if/else` branches where
one is dead code. See docs/runbooks/anti-patterns.md.

— Fail-closed by default (D-091)
When an enforcement layer can't run (Redis down, secret unset, DB error, signature
absent), the answer is denial, not permission. Returning `{ allowed: true }` on
Redis error, or 200 on a silent DB-write failure, is the worst possible failure mode
because it's silent AND it disables retries. Permit only on positive confirmation.

— Check every Supabase mutation (D-091 / D-094)
`@supabase/supabase-js` v2 does NOT throw on DB errors. Every `await x.update().eq(...)`,
`.insert(...)`, `.delete()`, `.upsert(...)` must surface failure as a throw or non-200
response. Two equivalent patterns:

  // Preferred (D-094): wrap the query, throw structured error on failure.
  await safeAwait(db.from("x").update({...}).eq("id", id), "x.update.context");

  // Also acceptable: destructure { error } and explicit-handle.
  const { error } = await db.from("x").update({...}).eq("id", id);
  if (error) throw new Error(`x.update failed: ${error.message}`);

For CAS-style updates (status guard), use `safeAwaitRowCount` with the expected count
so zero-row updates raise instead of silently no-op'ing (Greptile P1 #24 root cause).

See `apps/main/src/lib/db/safe-mutation.ts` for the helper module.

— Two layers of tenant isolation (D-091)
Every tenant-scoped query needs BOTH an app-layer filter AND a DB-layer constraint
(RLS via tenantClient, or an explicit `.eq("tenant_id", ...)` on service-role queries).
A single defense — even a correct one — is one bug away from cross-tenant leakage.

— External credentials in headers, never URLs (D-091)
URLs end up in proxy logs, CDN logs, APM traces, and Node `TypeError` messages.
Headers are routinely scrubbed; URLs are not. Use `Authorization: Bearer ...` even
when the API also accepts `?token=...`.

— Quota gates re-read between consuming ops (D-091)
A budget gate read once before a multi-batch loop will not catch overruns mid-loop.
Either re-check between batches, or use a DB-atomic reserve-row pattern. Concurrent
crons + retries can both pass the gate at run-start and double-spend.

— CAS-style status-guarded updates need row-count verification (D-091 round 2)
`.update({status:'X'}).eq("id", id).eq("status", 'Y')` does NOT throw when zero
rows match. Supabase JS returns `{ error: null }` whether the row was found-and-
updated or not-matched. Every CAS-style lock pattern MUST chain `.select('id')`
and assert the returned array length matches the expected affected-row count.

— Never `void` an async call in serverless without a justification (D-091 round 2)
`void someAsyncFn()` in a Vercel/Lambda function tells the host the work is
fire-and-forget. The host may terminate the process before the work completes,
silently dropping DB writes, audit rows, and alerts. Either `await` the call,
OR add a `// allow-void-async: <reason>` comment justifying that the work is
idempotent and retry-safe (and ideally moved into its own Inngest function).

— One assertPermission call per semantic operation (D-091 round 2)
Routes that switch on `body.action` or accept multiple HTTP methods must call
`assertPermission` separately for each operation with the correct (resource,
action) pair. Reusing a single permission gate for two semantically-different
operations is either over-permissive or under-permissive — both are bugs.

— Idempotency rows written AFTER dispatch, not before (D-091 round 2)
A webhook handler that inserts the dedup row before completing the dispatched
handler creates a "stranded state": if the process crashes between insert and
dispatch, retries are rejected as duplicates and the work never completes. The
dedup row's existence should indicate "fully processed," not "received." Use a
separate `processing_started_at` timestamp for in-flight tracking if reconcile
needs to recover stuck rows.

— State-machine transitions validate inputs at the function boundary (D-091 round 2)
If `progressTo`/`revertTo`/`transitionTo` accept any non-literal value, the
function itself MUST assert: (a) target is a valid enum value, (b) transition is
permitted from current state. Don't delegate this to callers — defense-in-depth
catches the day a route passes `body.target_stage` straight through.

— Webhook signatures: capture the encoding at integration time (D-091 round 2)
Different webhook providers use different signature encodings (hex, base64,
base64url). Mis-decoding silently rejects every valid webhook AND every
downstream enforcement step. At integration time, capture a recorded signature
fixture and write a unit test that verifies it passes — guards against a future
refactor flipping the encoding. Note the encoding in a comment near
constructEvent / verify call.

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

-----



-----



-----

## Model selection conventions

Default model is **Sonnet 4.6** (`claude-sonnet-4-6`). Most work — TypeScript, SQL, YAML, Vitest, config, scripted runbooks, contract tests, Dependabot config, RLS work, doc writing — runs on Sonnet.

Use **Opus 4.7** (`claude-opus-4-7`) only when a build prompt explicitly calls for it. 

### Switching rules

- Every build prompt indicates which model to use at the top.
- If a section uses Opus or Haiku, **switch back to Sonnet at the end** with `/model claude-sonnet-4-6`. Standing rule — apply it even if the build prompt forgets to say so.


-----

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

### Pull requests

**You can open and merge PRs into `dev`** under these conditions:

1. All required CI status checks pass.
1. The work is complete (not a WIP).
1. The merge isn’t into a protected release branch.

**Mandatory `## Audit` section in every PR description.**

Before opening a PR, you MUST run both audit subagents and paste their combined output into the PR body under an `## Audit` heading:

1. Invoke `d091-reviewer` for D-091 anti-pattern coverage.
2. Invoke `pre-pr-reviewer` for slop sweep, tests-for-intent, surgical-changes discipline, and the other CLAUDE.md rules outside D-091.
3. Combine both outputs into a single `## Audit` block in the PR description. Keep the format `pre-pr-reviewer` emits (Scope / Findings / Tests / Status lines).
4. If `Status` is anything other than `clean — no findings`, fix the findings or explain why each is acceptable in the same block, BEFORE pushing.

The `pr-audit-section-check` workflow enforces this — it reads the PR body, fails if the `## Audit` section is missing or empty or marked `TBD`. The check is required to merge. **You cannot bypass it.** Dependabot PRs are exempt (they're version bumps with no code logic).

**Workflow:**

- Open PR from feature branch into `dev` with a clear title and body summarizing the change. Include the `## Audit` block.
- Wait for CI to complete.
- If all checks pass, merge (squash merge by default unless the PR has logically separate commits worth preserving).
- Delete the feature branch after merge.
- If checks fail, do not merge. Either fix the failure in the same PR or stop and surface the failure to the user.

**You may NOT:**

- Merge a PR with failing or pending checks.
- Bypass branch protection rules.
- Force-push to `dev`, `main`, or `release/*`.
- Merge PRs into `main` (only the production pipeline does this).
- Open or merge `release/*` PRs — that’s the user’s call and the pipeline’s job.

-----

## Build prompts and sequencing

The CI/CD implementation prompts are in `ATC_CICD_Implementation___Build_Prompts_for_Claude_Code.md`. Each section is self-contained: manual prerequisites → invocation → prompt → verification → manual follow-ups.

**Sections run in order.** Don’t skip ahead. Each section’s manual prerequisites usually depend on prior sections.

**Manual prerequisites are the user’s job.** They happen outside Claude Code (GitHub UI, Vercel dashboard, local shell). When a build prompt is invoked, assume prerequisites are done unless the user says otherwise.

**Verification is shared.** You run the automated checks; the user inspects external systems (GitHub Actions UI, Vercel deployments, Supabase dashboard).

When resuming a build prompt mid-execution after a session break, read SESSION.md to find out where you left off, then continue from there. Don’t restart the section.

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

The v6 spec, the CI/CD pipeline spec, and the Self-Service Help addendum together are the source of truth.

- **Read relevant sections before writing code or docs.** Don’t paraphrase from memory.
- Cross-references in specs use `§N.M` notation. Follow them.
- **If a spec is ambiguous,** flag it, propose an interpretation, ask the user to confirm. Don’t invent behavior.
- **If a spec is wrong,** flag it. Don’t silently work around it. Update the spec (with user approval) so the next reader gets the corrected version.

-----

## Things to never do without explicit permission

- Delete files or branches (except your own feature branches after merging the PR they were for)
- Rename files
- Restructure directories
- Modify spec `.docx` files
- Modify build prompt `.md` files
- Edit prior MEMORY.md entries (additions only)
- Merge into `main` or `release/*`
- Force-push anywhere
- Install new runtime dependencies (dev-dependencies are OK if obviously needed for a task)
- Run anything against `atc-prod` other than reads
- Run production deploy commands (`vercel --prod`, etc.)
- Create migrations against production databases
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
- If you switched to Opus or Haiku, switch back to Sonnet: `/model claude-sonnet-4-6`.
- Update SESSION.md.

Don’t pad the wrap-up. A few lines is enough.