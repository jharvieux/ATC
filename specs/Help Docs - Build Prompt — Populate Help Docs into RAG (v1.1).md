# Build Prompt — Populate Help Docs into RAG (v1.1)

**Version note:** v1.1 adds a PR-time documentation auto-update workflow. When code changes touch admin-feature paths, Claude Code automatically analyzes the diff, writes documentation updates, classifies them as low-risk (auto-commit to PR branch) or structural (separate PR for human review), and self-rates confidence to gate ambiguous cases to human review. The original RAG ingestion behavior is unchanged.

**Target:** Claude Code, working in the AI Travel Concierge monorepo.

**Source specs:**

- `AI_Travel_Concierge_Spec_v6_Full.docx` — §6 (RAG service), §22 (ingestion pipeline) are required reading.
- `Self_Service_Help_Addendum_v1.docx` — §3.4 (platform-docs scope) defines the target.
- `MEMORY.md` — read before starting.

If any spec disagrees with this prompt, the spec wins. Flag the disagreement and stop for clarification.

**Prerequisite:** the 12 admin help docs must already exist in `apps/main/content/help/`. If they don’t, run the “Generate Tenant Admin Help Documentation” build prompt first.

-----

## Model usage instructions — read first

**Use Claude Sonnet for this entire task.** No Opus needed — this is a well-scoped integration task with clear inputs (Markdown files) and clear outputs (RAG chunks with metadata).

-----

## What you’re producing

A pipeline that takes the Markdown files in `apps/main/content/help/` and ingests them into the RAG service under a new RAG scope `platform-docs`. The Help AI (per addendum §4) retrieves from this scope when answering “I need help” queries.

Specifically, you’re delivering:

1. A new RAG scope value `platform-docs` (a small extension to the v6 §6.9 two-scope model — already authorized by addendum §3.4).
1. An ingestion script (`scripts/ingest-help-docs.ts`) that processes the Markdown files into chunks.
1. Integration with the existing ingestion pipeline (v6 §22.4) for PII redaction (defensive — the docs shouldn’t contain PII but the pipeline runs anyway).
1. A GitHub Actions workflow that re-ingests on every release that touches `apps/main/content/help/**`.
1. Tests that confirm retrieval works against the new scope.
1. **(v1.1)** A second GitHub Actions workflow that automatically writes documentation updates when code changes touch admin features. Two-track routing: low-risk edits auto-commit to the same PR branch as the code change; structural changes open a separate PR for human review. Confidence threshold (initial 0.65) gates ambiguous cases to human review.
1. **(v1.1)** A `help_docs_auto_updates` audit table and a daily summary GitHub issue (`docs-auto-update-summary`) for visibility into all auto-merges.
1. **(v1.1)** A one-click revert workflow for backing out any auto-merge.

-----

## Pre-work — before you write any code

1. Read v6 §6 in full, especially §6.9 (scope model), §6.10 (authority feedback), §6.11 (PII), §6.12 (retention).
1. Read v6 §22 in full, especially §22.4 (normalization pipeline) and §22.6 (revised global review).
1. Read addendum §3.4 (platform-docs scope authorization).
1. Inspect the existing RAG service code at `apps/rag/` (per CI/CD doc) — specifically:
- The `tenant_registry` table and its scope handling.
- The `/api/retrieve` endpoint and how it filters by scope.
- The `/api/ingest` endpoint and the chunk-creation flow.
1. Produce a written plan in chat covering:
- Schema changes needed (CHECK constraints, indexes).
- Code changes to retrieval to support `scope='platform-docs'`.
- Chunking strategy (see below).
- Embedding model (use whatever §6 specifies; do not change it).
- Workflow design.

**Do not start coding until the user approves the plan.**

-----

## Scope (what’s in this build)

### A. Schema changes

The `knowledge_chunks` table (per v6 §6) currently has a `scope` column accepting `'global'` and `'tenant'`. Add `'platform-docs'` as a valid value:

```sql
-- supabase/migrations/YYYYMMDDHHMMSS_add_platform_docs_scope.sql
ALTER TABLE public.knowledge_chunks
  DROP CONSTRAINT IF EXISTS knowledge_chunks_scope_check;

ALTER TABLE public.knowledge_chunks
  ADD CONSTRAINT knowledge_chunks_scope_check
  CHECK (scope IN ('global', 'tenant', 'platform-docs'));
```

(Adapt the exact constraint name to match what exists; check the current migration history.)

Also: add an index on `(scope, category)` if not already present, since the Help AI will retrieve with scope filter.

### B. Retrieval changes

The retrieval query in `apps/rag/` currently filters something like:

```sql
WHERE scope = 'global'
   OR (scope = 'tenant' AND tenant_id = $caller_tenant_id)
```

Add the platform-docs scope as a separate, opt-in filter. The Help AI passes a flag in its retrieve request (e.g., `target_scope: 'platform-docs'`). When set, the query becomes:

```sql
WHERE scope = 'platform-docs'
```

That is, the Help AI does NOT mix platform-docs with global or tenant content — its retrieval is scoped strictly to platform-docs. The customer-facing concierge AI continues to retrieve only from `global` + `tenant`, never from `platform-docs`. This matches the addendum decision that the concierge does not have access to admin documentation.

Update the `POST /api/retrieve` request schema (v6 §8.4) to accept the new `target_scope` parameter. Backward-compatible default: if absent, behaves exactly as today.

### C. Chunking strategy

Each Markdown file becomes 1–N chunks. Rules:

- Split on H2 (`##`) boundaries. Each H2 section is a chunk.
- If an H2 section is shorter than 200 tokens, merge with the next section (or the file’s introduction).
- If an H2 section is longer than 800 tokens, split at H3 (`###`) boundaries.
- Hard maximum chunk size: 1,200 tokens. If a single H3 section exceeds this, fall back to paragraph-boundary splitting.
- Each chunk retains:
  - The file’s frontmatter as metadata (`title`, `description`, `tags`, `slug`).
  - The H2 section heading as `section_title` in chunk metadata.
  - The relative position of the chunk in the file (`chunk_index`, `total_chunks`).
  - A constructed `source_url` of the form `/admin/help/{slug}#{section_anchor}` so the Help AI can cite back to the docs viewer.

Tags from frontmatter feed the chunk’s `category` field where they map cleanly (e.g., `tags: [onboarding]` → `category: 'onboarding'`); otherwise use `category: 'platform-docs'` as a generic fallback.

### D. Authority scoring

Per v6 §6, chunks have authority scores. Platform-docs chunks are:

- `authority: 1.00` — they ARE the source of truth for platform behavior.
- `authority_tier: 'platform-official'` — add this as a new authority tier value if needed; otherwise reuse `'official'`.
- Authority feedback loop (v6 §6.10) is DISABLED for platform-docs chunks. Thumbs-down on a Help AI response that cited a platform-docs chunk means the doc is wrong — that’s an engineering task, not an authority signal. Add a check in the feedback handler that skips authority nudges for `scope = 'platform-docs'`.

### E. PII redaction

Defensive: pass content through the v6 §22.4 pipeline anyway. The docs shouldn’t contain PII (they’re written by engineers about platform features), but the pipeline is cheap and catches mistakes.

If PII is detected in a doc file during ingestion, the ingestion run fails loudly and posts a comment on the triggering PR or commit. Do NOT silently redact and proceed — a doc author needs to fix the source.

### F. Ingestion script

Create `scripts/ingest-help-docs.ts`. Behavior:

1. Read all `.md` files in `apps/main/content/help/`.
1. Parse frontmatter.
1. Chunk per the strategy above.
1. Run each chunk through PII redaction (fail loud on detection).
1. Generate embeddings (use the same embedding model v6 §6 specifies).
1. Upsert chunks into `knowledge_chunks` keyed by `(scope, source_url, chunk_index)`. Upsert, not insert, so re-running the script on updated docs replaces existing chunks rather than duplicating.
1. After upsert, delete any platform-docs chunks whose `source_url` no longer corresponds to a file in the docs directory (handles deleted docs).
1. Log a summary: files processed, chunks created, chunks updated, chunks deleted.

The script must be runnable both locally (against `atc-dev` or `atc-test`) and in CI.

### G. GitHub Actions workflow

Create `.github/workflows/ingest-help-docs.yml`. Triggers:

- Push to `dev` branch that touches `apps/main/content/help/**`.
- Push to `release/*` branch that touches `apps/main/content/help/**` (so production gets the update on next release).
- Manual `workflow_dispatch`.

Environment: matches the branch (per CI/CD §3). `dev` → ingest into atc-dev’s RAG project. `release/*` → ingest into atc-test (staging), then on production approval, ingest into atc-prod.

Steps:

1. Checkout.
1. Install dependencies.
1. Run the ingest script against the appropriate environment’s RAG service.
1. Report summary as workflow output.
1. On failure: surface the error in the Action summary AND open a GitHub issue tagged `help-docs-ingestion-failed` so it doesn’t get silently missed.

### H. Tests

- Unit test: chunking strategy. Given a known input file, produce the expected chunks. Use snapshot tests for chunk boundaries.
- Unit test: PII detection fails the run when a fake SSN is present in a fixture file.
- Integration test: ingest a small fixture set, retrieve via `/api/retrieve` with `target_scope: 'platform-docs'`, confirm results come back with the correct metadata and `authority_tier`.
- Integration test: retrieve via `/api/retrieve` with default scope (`global` + `tenant`) and confirm platform-docs chunks are NOT returned.

### I. Documentation for engineering

Create `apps/main/content/help/CONTRIBUTING.md` (NOT a tenant-facing help doc — this is for engineers):

- How to add or edit a doc.
- The frontmatter contract.
- How chunking works (briefly) so authors understand why H2 boundaries matter.
- How to test locally.
- What happens on push (the workflow).
- How the auto-update workflow behaves (sections J–M below) — what triggers it, what gets auto-committed, what gets a separate PR, how to override.

### J. Auto-update workflow: triggers and detection

A second GitHub Action, `.github/workflows/auto-update-help-docs.yml`, runs on every PR (event: `pull_request`, `pull_request_target` for fork PRs). Its job: detect when code changes affect admin-facing behavior and write doc updates automatically.

**Trigger conditions** (any one is sufficient):

The PR diff touches any of these paths:

- `apps/main/src/app/admin/**` — admin console UI routes.
- `apps/main/src/app/api/admin/**` — admin API routes.
- `apps/main/src/components/admin/**` — admin UI components.
- `supabase/migrations/**` — schema migrations (filtered: only those affecting tables that admin features expose, by table-allowlist).
- `apps/main/src/lib/billing/**` — billing logic (affects `08-usage-and-billing.md`).
- `apps/main/src/lib/personas/**` — persona configuration (affects `04-personas.md`).
- `apps/main/src/lib/branding/**` — branding logic (affects `03-branding.md`).
- Any file matching `**/admin-*.{ts,tsx}`.

(The full path allowlist lives in `.github/auto-update-help-docs.config.json` so it can be tuned without editing the workflow.)

The PR has a label `force-docs-check`, applied manually by anyone who wants the auto-update to run on a PR that didn’t match the allowlist.

**Skip conditions:**

- PR has label `skip-docs-update` (escape hatch for emergencies; should be rare).
- PR is itself a docs-only PR (only touches `apps/main/content/help/**`).
- PR is from a bot account other than the auto-update bot itself (avoid recursion).

### K. Auto-update workflow: writing the changes

When triggered, the Action invokes Claude Code with a focused prompt that includes:

1. The PR title, description, and full diff.
1. The current contents of all 13 help doc files (or a subset if a coarse classifier narrows the scope first).
1. The audience persona and jargon rules from this prompt’s doc-generation companion (v1.1).
1. The list of affected docs identified by mapping the changed paths to doc files (see mapping table below).
1. Instructions to:
- Identify which docs (if any) are made incorrect or incomplete by this PR.
- Write updates that match the existing doc voice.
- For each proposed change, self-rate confidence on a 0.00–1.00 scale.
- Classify each change as **low-risk** or **structural** per the criteria below.
- Output a structured response (JSON) listing proposed changes with file path, change description, full new file content, classification, confidence, and rationale.

**Path-to-doc mapping (initial; tune over time):**

|Code path touched                                                 |Likely affected docs                   |
|------------------------------------------------------------------|---------------------------------------|
|`apps/main/src/app/admin/branding/**`                             |03-branding.md                         |
|`apps/main/src/app/admin/personas/**`                             |04-personas.md                         |
|`apps/main/src/app/admin/crm/**`                                  |05-crm.md                              |
|`apps/main/src/app/admin/quotes/**`, `bookings/**`                |06-quotes-and-bookings.md              |
|`apps/main/src/app/admin/rag/**`, `apps/rag/**`                   |07-rag-content.md                      |
|`apps/main/src/lib/billing/**`, `apps/main/src/app/admin/usage/**`|08-usage-and-billing.md                |
|`apps/main/src/app/admin/team/**`, permissions code               |09-team-and-permissions.md             |
|`apps/main/src/app/admin/customers/**`                            |10-customer-management.md              |
|Supervisor code                                                   |11-supervisor-and-quality.md           |
|Cross-cutting / unclear                                           |12-troubleshooting.md + flag for review|

If a PR touches paths not in the mapping, Claude Code is asked to assess all 13 docs but with a higher threshold for proposing changes.

### L. Auto-update workflow: low-risk vs structural classification

**Low-risk changes (auto-commit to PR branch, no human review of the doc edit specifically):**

- Edits to existing doc files only.
- Word-level changes within existing sections.
- Adding a sentence or paragraph to an existing section (the section already existed).
- Updating a step in an existing ordered list.
- Updating a UI label reference (button name change, field rename).
- Updating a frontmatter field (`last_updated`, `tags`).
- Updating a glossary entry’s definition.

**Structural changes (separate follow-up PR opened, requires human review and merge):**

- Creating a new doc file.
- Deleting a doc file.
- Adding or removing an H2 section in an existing file.
- Changing a doc’s `slug` or `order` in frontmatter.
- Changing the doc set’s overall nav structure.
- Any change to `CONTRIBUTING.md`.
- Any change to the glossary that adds or removes an entry (edits to existing entries are low-risk).
- Any change to ≥30% of a single doc’s word count in one update.
- Any change Claude Code’s self-rated confidence falls below the threshold (see below).

**Confidence threshold for low-risk classification:**

The threshold lives in `.github/auto-update-help-docs.config.json` as `low_risk_confidence_threshold`. Initial value: **0.65**.

Rationale for the initial threshold: looser than typical, on user direction. The trade-off is more auto-merges, more chance of a low-quality doc edit shipping without review. Mitigation: the daily summary issue (§M) makes auto-merges visible and easy to revert.

**Revisit the threshold after 30 days of data.** Specifically: count auto-merges, count any that were subsequently reverted, count any that were edited within 7 days of auto-merge. Use those numbers to either tighten (if many bad merges) or hold (if it’s working).

If confidence is below threshold OR the change is classified structural, route to the structural pathway regardless.

### M. Auto-update workflow: routing logic

**For low-risk changes:**

1. Auto-commit the doc updates to the same PR branch as the code change. Commit message: `docs(auto): update X for [PR title]` (signed by the `docs-bot` GitHub App).
1. Post a PR comment summarizing the doc changes: which files, brief summary per file, confidence score.
1. The doc changes ship in the same PR as the code change. The engineer reviewing the code sees the doc updates in the same review surface. No separate gate.
1. If the PR is merged, the doc changes merge with it. If the PR is closed without merging, the doc changes go with it.

**Edge case: PR already merged when Action runs**
This can happen with fork PRs or race conditions. Fallback: open a new PR `docs(auto): follow-up for #{merged_pr_number}` against `dev` with the doc changes. Label it `auto-merged-followup`. Auto-merge it after CI passes (no human review on doc-only follow-ups that are low-risk).

**Edge case: merge conflict on the PR branch**
If auto-commit can’t fast-forward (branch was force-pushed, conflicts), fall back to opening a comment on the PR with the proposed changes as a code block and a link to apply them as a suggested change. The engineer can apply with one click.

**For structural changes:**

1. Open a new PR `docs(auto-structural): [description]` against `dev`.
1. Label it `docs-update-needs-review`.
1. Include in the PR body: the triggering code PR’s link, the list of structural changes, Claude Code’s rationale, and the confidence score.
1. Do NOT auto-merge. Engineer reviews and merges as part of normal workflow.
1. Block the structural PR from merging until the triggering code PR has merged (use the GitHub `auto-merge` feature with branch protection rules).

**Daily summary issue:**

A scheduled workflow runs at 09:00 UTC daily. It collects all commits on `dev` with the `docs(auto)` prefix from the prior 24 hours and updates a single rolling GitHub issue labeled `docs-auto-update-summary`. The issue body is replaced each day with a summary:

- Total auto-merges in the last 24h.
- Per-merge: file, brief summary, link to commit, confidence score, link to triggering code PR.
- Rolling 30-day stats: total auto-merges, total reverts, average confidence.

This is the single point of visibility for auto-merge activity. Engineering watches this issue. Any concerning pattern surfaces here.

**Revert mechanism:**

A workflow_dispatch action `revert-last-auto-merge.yml` accepts a commit SHA, verifies it was an auto-merge (by checking commit author = `docs-bot`), creates a revert commit on `dev`, and links it back to the original auto-merge in the daily summary issue. One-click rollback if a bad auto-merge ships.

### N. Auto-update workflow: cost controls

The auto-update workflow uses Claude API calls and is potentially expensive. Controls:

- Per-PR cap: one auto-update analysis run per PR. Re-runs on push are coalesced — only the latest commit’s diff is analyzed.
- Per-day platform cap: 50 auto-update runs per day across all PRs. Beyond cap: the action skips with a comment “auto-update cap reached for today; manual doc update may be required.”
- Diff size cap: if the diff is over 50,000 lines (rare but possible — e.g., a dependency lockfile update), the action skips with a comment.
- API key: `CLAUDE_CODE_API_KEY` (already added in v1 for the bug auto-fix workflow). Reused here — same key, same spending limit.
- All Claude API calls in this workflow log to cost-attribution under `platform-docs-autoupdate`.

### O. Auto-update workflow: safeguards

Things to build in defensively:

- **Loop prevention.** The auto-update workflow ignores PRs authored by `docs-bot`. Auto-commits to PR branches must not retrigger the workflow on the same PR — use commit-author filtering plus a marker in the commit message.
- **Jargon-check enforcement.** Every auto-generated doc edit passes through the jargon-checker (forbidden-words list from the v1.1 doc-gen prompt). A jargon-check failure downgrades the change to structural classification (forces human review) regardless of confidence score.
- **Diff sanity check.** If the auto-generated change would delete more than 20% of a doc’s existing content, force structural classification.
- **PII check.** If the auto-generated doc edit somehow ends up with PII (shouldn’t happen since input is code, but defensive), the existing PII pipeline (§E) fails the run and surfaces the issue.
- **Backout-ability.** Auto-commits go in their own commit, never squashed with code changes, so `git revert` is clean.
- **Audit trail.** Every auto-update run logs to a `help_docs_auto_updates` table (id, pr_number, triggered_at, files_changed, classification, confidence_per_file, outcome). Useful for the 30-day threshold review.

-----

## Out of scope (do NOT build in this pass)

- Indexing customer-facing help content (no such content yet; deferred per addendum).
- A separate Help AI eval suite — that’s handled in the main Self-Service Help build prompt’s quality work.
- Versioning of help docs separate from code (per addendum §3.1, docs ship with code).
- Authority feedback loop for platform-docs (explicitly disabled — §D above).
- Surfacing chunks to tenant admins for review (platform-docs is NOT in the tenant review queue per v6 §22.5).

-----

## Standards to follow

- TypeScript strict mode.
- Migrations are additive only (v6 §29.6).
- Idempotent ingestion — running the script twice in a row produces the same DB state.
- No secrets in `NEXT_PUBLIC_*` env vars.
- All embedding API calls log to cost-attribution (v6 §27.12) under a synthetic `platform-docs-ingestion` identifier.

-----

## New env vars

|Variable                       |Required|Secret|Description                                                          |
|-------------------------------|--------|------|---------------------------------------------------------------------|
|`RAG_INGEST_URL_DEV`           |Yes     |No    |Dev RAG service URL for ingestion                                    |
|`RAG_INGEST_URL_STAGING`       |Yes     |No    |Staging RAG service URL                                              |
|`RAG_INGEST_URL_PROD`          |Yes     |No    |Production RAG service URL                                           |
|`RAG_INGEST_SERVICE_TOKEN`     |Yes     |Yes   |Service-to-service JWT for ingest auth (per v6 §8.3)                 |
|`DOCS_BOT_APP_ID`              |Yes     |No    |GitHub App ID for the auto-update bot (separate from main GitHub App)|
|`DOCS_BOT_PRIVATE_KEY`         |Yes     |Yes   |GitHub App private key for docs-bot                                  |
|`DOCS_AUTOUPDATE_DAILY_CAP`    |Yes     |No    |Platform-wide daily cap on auto-update runs (default 50)             |
|`DOCS_AUTOUPDATE_DIFF_LINE_CAP`|Yes     |No    |Max diff size in lines to consider (default 50000)                   |

If existing env vars cover these, reuse rather than adding new ones. Flag any naming conflicts.

-----

## Hand-off checklist (you complete this before declaring done)

- [ ] Plan approved by user before any code was written.
- [ ] Migration applied successfully and reversible.
- [ ] Retrieval changes do not break existing global+tenant retrieval (regression test passes).
- [ ] Ingestion script runs cleanly against atc-dev with the actual help docs.
- [ ] Chunk count and size distribution looks sane (no 5-token chunks, no 5,000-token chunks).
- [ ] PII detection fixture test passes (script fails loudly on PII).
- [ ] GitHub Action runs successfully on a test commit to `apps/main/content/help/**`.
- [ ] Help AI retrieval returns relevant chunks for at least 3 sample admin questions (write the questions yourself and try them).
- [ ] Confirmed: customer-facing concierge retrieve calls do NOT return platform-docs chunks.
- [ ] CONTRIBUTING.md is clear enough that another engineer could add a new doc without help.
- [ ] Auto-update workflow triggers on a test PR touching an admin path.
- [ ] Auto-update workflow correctly classifies a word-level edit as low-risk and auto-commits.
- [ ] Auto-update workflow correctly classifies a “new doc file” change as structural and opens a separate PR.
- [ ] Loop-prevention verified: an auto-commit does not retrigger the workflow.
- [ ] Jargon-check enforcement verified: an auto-generated edit containing “endpoint” is force-classified as structural.
- [ ] Daily summary issue updates correctly with auto-merge entries.
- [ ] Revert workflow successfully reverts a test auto-merge.
- [ ] Per-day platform cap enforced (test by simulating cap reached).
- [ ] `help_docs_auto_updates` audit table records each run accurately.

-----

## End-of-build deliverables (in chat, not files)

- One-line summary of what was built.
- Sample retrieval results for 3 admin queries (e.g., “How do I add a custom domain?” → which chunks came back with what scores).
- List of any decisions made not covered by this prompt.
- Suggested MEMORY.md entries for those decisions.
- Open items for follow-up (e.g., when to enable Help AI doc-citation rendering in the chat UI).