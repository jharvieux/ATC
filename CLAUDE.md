# CLAUDE.md — AI Travel Concierge

Working instructions for Claude Code sessions in this repo. Read this first, every session, before doing anything else.

-----

## Session start protocol

Every session, in this order:

1. Read `/MEMORY.md` in full.
2. Read `/SESSION.md` in full.
3. If a build prompt is being executed, read it.
4 State in one short paragraph: what you understand the current state to be, and what you’re about to do.
5. Wait for the user to confirm or correct before acting.

Step 4 is cheap and prevents expensive misreads of context.

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

**Workflow:**

- Open PR from feature branch into `dev` with a clear title and body summarizing the change.
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