# CLAUDE.md — AI Travel Concierge

Working instructions for Claude Code sessions in this repo. Read this first, every session, before doing anything else.

> **Branch protection — read before you commit.** `dev` and `main` are protected. Never commit directly to either. **Every change lands via a PR into `dev`** — that includes edits to this file, MEMORY/SESSION, docs, and workflow YAML, not just application code. Branch off `dev` (`feature/*` or `docs/*`), push, open the PR, let required CI pass, then squash-merge. Full rules in "Git, commits, pushes, and PRs" below.

-----

## Session start protocol

Every session, in this order:

1. Read `/MEMORY-INDEX.md` (one line per decision, newest first). Do NOT read `/MEMORY.md` in full — it's the append-only archive; `grep` the full entry out of it when a task touches that area.
2. Read `/SESSION.md` in full.
3. If a build prompt is being executed, read it.
4. State in one short paragraph: what you understand the current state to be and what you're about to do.
5. Wait for the user to confirm or correct before acting on anything that needed a judgement call.

Step 4 is cheap and prevents expensive misreads of context.

> **Triage is manual** (changed 2026-06-27). The old auto-triage-every-session sweep is gone. When the user asks to triage open issues/PRs/security alerts (or types `/triage`), follow `docs/runbooks/triage.md`. Don't run it unprompted.

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

At session start, read SESSION.md and resume from "Next step" unless the user redirects.

**Writing it is a plain whole-file overwrite — no hook, no prepend rule (the opposite of MEMORY.md).** Use the Write tool to replace the file with the fields above, freshly filled in. Don't try to preserve or prepend prior state: SESSION.md is transient working state, not history, so last-write-wins is correct.

-----

## End-of-session protocol

Triggered by any of:

- The user signals end of session ("we're done," "stop here," "log off," etc.).
- You estimate you are approaching the context window limit.
- A long-running operation is about to start that might not finish in remaining context.

Steps, in order:

1. **Never leave the repo broken.** If there are uncommitted changes, ensure they typecheck and don't break the build. If they don't, either fix them or stash them on a WIP branch — don't leave broken code on a working branch.
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
1. State briefly what was done and what's next.

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

— Don't restate code in prose
When describing a change you already made via Edit/Write, don't repeat the full function or file in a chat markdown block. Show only the changed lines with a one-line anchor (or point to `file:line`). The tool call already carries the diff — repeating it in prose is pure token waste.
This doesn't shrink option-presentation, uncertainty disclosures, or other required structure elsewhere in this file — it's about not re-printing code that was already shown.

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
Define success criteria. Loop until verified. Strong success criteria let you loop independently.

 — Use the model only for judgment calls
Use me for: classification, drafting, summarization, extraction.
Do NOT use me for: routing, retries, deterministic transforms. If code can answer, code answers.

— Tests verify intent, not just behavior
Tests must encode WHY behavior matters, not just WHAT it does. A test that can't fail when business logic changes is wrong.

 — Checkpoint after every significant step
Summarize what was done, what's verified, what's left. Don't continue from a state you can't describe back. If you lose track, stop and restate.

 — Match the codebase's conventions, even if you disagree
Conformance > taste inside the codebase. If you genuinely think a convention is harmful, surface it. Don't fork silently.

— Fail loud
"Completed" is wrong if anything was skipped silently. "Tests pass" is wrong if any were skipped. Default to surfacing uncertainty, not hiding it.

-----

## D-091 anti-patterns (authoring checklist)

Scan these 20 titles before writing app code. **Full catalog — symptom, example, codebase instances, the `pnpm check:*` gate, and the why — lives in `docs/runbooks/anti-patterns.md`.** Open that runbook the moment a title is relevant to what you're writing. The `d091-reviewer` agent enforces all of these at PR time.

1. **No stub-shaped code** — every param affects output; every variant reachable; no dead branches.
2. **Fail-closed** — when an enforcement layer can't run (Redis/DB/secret/signature absent), deny, don't permit.
3. **Check every Supabase mutation** — supabase-js v2 doesn't throw; `safeAwait` / destructure `{ error }` (CAS → `safeAwaitRowCount`).
4. **Two layers of tenant isolation** — app-layer filter AND DB-layer constraint (RLS / explicit `.eq("tenant_id", …)`).
5. **Credentials in headers, never URLs** — `Authorization: Bearer …`, not `?token=…`.
6. **Quota gates re-read between consuming ops** — re-check between batches, or DB-atomic reserve-row.
7. **CAS status-guarded updates verify row count** — `.update(...).eq("status",'Y')` returns `error:null` on zero rows; chain `.select('id')`.
8. **No unjustified `void` async in serverless** — `await` it, or `// allow-void-async: <reason>` (idempotent/retry-safe).
9. **One assertPermission per semantic operation** — `body.action`/multi-method routes need a gate per (resource, action).
10. **Idempotency rows written AFTER dispatch** — the dedup row must mean "fully processed," not "received."
11. **State-machine transitions validate at the function boundary** — `progressTo`/`revertTo`/`transitionTo` assert enum-valid + permitted; don't trust callers.
12. **Webhook signatures: capture the encoding at integration time** — hex vs base64 vs base64url; add a recorded-signature fixture test.
13. **Destructive migrations ship AFTER the read-switchover, in their own PR** (#137) — expand → switch reads → contract as THREE merges.
14. **Permission grants belong with the route PR** (#1173) — same PR adds the `key(...)` entry + the matrix test tuple.
15. **Every admin route asserts platform-admin in the handler** (#1393/G5) — `proxy.ts` is only a cookie-shape check.
16. **Never echo a raw error `.message`/`.details` into an API response** (#1393/G1) — route through `dbErrorResponse(error)`.
17. **Stored/rendered URL fields use `safeUrl`, not `z.string().url()`** (#1393/G2) — and fetch outbound via `fetchGuarded`.
18. **Counter/financial mutations must be atomic, not read-modify-write** (#1393/G3) — DB-side increment or CAS reserve-row.
19. **Public/anon rate limits must be backed by a shared store, not a module-level `Map`/`Set`** (#1393/G4) — Redis/DB, fail closed.
20. **Webhooks need replay protection, not just a signature** (#1393/G6) — timestamp window / dedup row / nonce / version guard + replay fixture test.

-----

## Honesty about uncertainty

**Never present a guess as a fact.** If uncertain about a fact, statistic, date, quote, API behavior, library version, or anything else, say so explicitly *before* the uncertain claim. "I'm not certain about this, but…" is always better than confident wrong. If unsure about what was in the spec re-read that section before assuming anything.

Do not fill gaps with plausible-sounding information. If you don't know, say you don't know and propose how to find out (read a file, run a command, search the docs, ask the user).

Applies especially to:

- Library/API behavior you haven't verified in this session
- Version-specific syntax (Next.js, Supabase, Vercel CLI, GitHub Actions)
- What's in spec files you haven't read or only skimmed in this session — read them, don't guess
- Anything where being wrong would cost the user real time or money

-----

## Show options before acting when unsure

When facing a choice with non-obvious trade-offs, **present the options before acting.** Don't pick silently. Format:

- Brief description of the choice
- 2–4 labeled options, each with the trade-off in one line
- Your recommendation and why
- Stop and wait for the user's call

Exceptions where you can proceed without asking:

- The choice is purely mechanical (formatting, naming convention already established)
- The build prompt or spec already specifies the answer
- The user has already given a standing instruction covering this case (check MEMORY.md)

When in doubt, ask. The user prefers an extra question over an unwanted change.

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
- Never commit directly to `main` ever. `main` is updated only by the production pipeline's auto-merge step.
- Never auto-merge `release/*` branches anywhere. Release branches go through the manual approval gate in the CI/CD pipeline. You may push to `release/*` if executing a release task, but the pipeline owns promotion.

### Before every push

Run `pnpm verify` (full: typecheck + lint + tests + slop-check) before `git push`. The Stop hook covers turn-end pushes; mid-session pushes bypass it. CI catches everything `pnpm verify` would catch, but each CI run costs minutes and creates noise on failing PRs. Running locally first surfaces breaks while you still have the context to fix them cleanly.

The rule is mandatory for application-code PRs. For PRs touching only docs, workflow YAML, or other non-code files, `pnpm verify` is fast (most steps are no-ops on those files) — still run it.

If `pnpm verify` fails, fix and re-verify before pushing. If a failure is pre-existing on dev (not caused by your branch), call it out to the user and don't block.

### Migration PRs — stop-rule

**If your diff touches `**/supabase/migrations/` or `db/*snapshot*.sql`, STOP and follow `docs/runbooks/migrations.md` before opening the PR.** Snapshot regen, the test-DB ledger hazard, the no-CONCURRENTLY rule, and expand→switch→contract sequencing all live there, and two CI guards (`check:policy-snapshot`, `rls-snapshot-diff`) will block you if you skip them.

### Pull requests

**You can open and merge PRs into `dev`** when (1) all required CI status checks pass, (2) the work is complete (not a WIP), and (3) the merge isn't into a protected release branch.

Every PR needs **hash-bound audit marker comments** posted by the audit agents (`d091-reviewer` + `pre-pr-reviewer`) — the `pr-audit-section-check` gate is required and you cannot bypass it. **The full mechanics (how the diff-hash works, what stales an audit, exemptions, hard rules) live in `docs/runbooks/pr-workflow.md`.** The essential ordering:

1. `pnpm verify` passes — clean typecheck, lint, tests, slop-check.
2. Push the branch.
3. **Open the PR** (`gh pr create`). No `## Audit` block needed — `pre-pr-reviewer` writes it.
4. **Wait for required CI to go green** (`Typecheck`, `Lint`, `Test`, `Guards & Build`, security/contract jobs). Get CI clean BEFORE running the agents — this stops an unrelated fix from re-staling the audit.
5. **Then run both audit agents, LAST** — `d091-reviewer` FIRST, then `pre-pr-reviewer` (it reads d091's comment to build the combined `## Audit` body). They self-post their marker comments — never post markers manually.
6. If either reports findings: fix, push, let CI go green again, re-run that agent.
7. Once all checks pass, squash-merge and delete the branch.

**Model selection for the FIRST audit run:** default Sonnet; override to Opus (`model: "opus"`) when the diff is ≥10 files / ≥500 net-added lines, includes a SQL migration, adds a net-new API route / Inngest fn / cron, touches webhook signatures / idempotency / state-machine transitions, or adds a service-role code path. Re-runs after fix-commits use Sonnet. Full criteria in `pr-workflow.md`.

**Exemptions** (no audit agents): Dependabot PRs, and doc-only PRs (every changed file matches `*.md`/`docs/**`/`specs/**` — a single non-doc file disqualifies it).

**You may NOT:**

- Run the audit agents before the PR exists (they abort when `gh pr view` is empty — correct).
- Manually post the `<!-- d091-audit:v1 -->` / `<!-- prepr-audit:v1 -->` marker comments.
- Merge a PR with failing or pending checks.
- Bypass branch protection rules.
- Force-push to `dev`, `main`, or `release/*`.
- Merge PRs into `main` (only the production pipeline does this).
- Open or merge `release/*` PRs — that's the user's call and the pipeline's job.

-----

## Build prompts and sequencing

The CI/CD implementation prompts are in `ATC_CICD_Implementation___Build_Prompts_for_Claude_Code.md`. Each section is self-contained: manual prerequisites → invocation → prompt → verification → manual follow-ups.

-----

## File and directory conventions

- **Specs** (read-only source of truth, `.html`): separate `.html` file per spec section. Never modify. If a build prompt disagrees with a spec, the spec wins — flag and stop.
- **Build prompts** (`.md`): execution instructions. Don't modify unless the user explicitly asks for a build-prompt edit.
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

- **Read relevant sections before writing code or docs.** Don't paraphrase from memory.
- Cross-references in specs use `§N.M` notation. Follow them.
- **If a spec is ambiguous,** flag it, propose an interpretation, ask the user to confirm. Don't invent behavior.
- **If a spec is wrong,** flag it. Don't silently work around it. Update the spec (with user approval) so the next reader gets the corrected version.

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
- Overwrite `SESSION.md` (it's transient state, not history)
- Commit and push to feature branches
- Open PRs into `dev`
- Merge PRs into `dev` when CI passes
- Delete your own feature branches after merge
- Switch models with `/model`
- Run triage on demand (`docs/runbooks/triage.md`) when the user asks
- Ask the user a clarifying question — always preferred over guessing

-----

## When you finish a task

- State what you did, briefly.
- Note any verification the user should run (UI checks, dashboards, deploys).
- Note any follow-ups flagged in the build prompt's "Manual follow-ups" section.
- If a decision was made worth logging — write the MEMORY.md entry.
- Update SESSION.md.

Don't pad the wrap-up. A few lines is enough.
