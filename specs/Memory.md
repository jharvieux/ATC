# MEMORY.md — AI Travel Concierge Platform Decision Log

This file is the working decision log for the AI Travel Concierge platform. It captures significant decisions, the reasoning behind them, and what was rejected. Read this at the start of every session before doing anything.

**Conventions:**

- Newest entries at the top.
- Each entry: date, decision, why, what was rejected, related artifacts.
- “Open” entries are decisions still pending — resolve before they go stale.

-----

## 2026-05-16 — §12 AI Behavior Evaluation Harness deferred (design-only)

### D-024 — Ship eval-harness design doc, defer implementation until app exists

**Decision:** §12 (AI behavior evaluation harness) ships as design-only this round. Commit `docs/evals/design.md` covering scoring strategy, judge prompt design, eval-set hygiene, regression threshold, sampling strategy, cost projection, and storage schema. Do NOT build the runner, SQL migration, CI job, or eval snapshots yet.

**Why:** The application has no persona prompts (`src/prompts/`), no tool definitions (`src/tools/`), and no production conversations. There is literally nothing to evaluate or sample. Building the harness infrastructure now would create code that sits idle and rots before it runs once. The design work itself is the part that needed Opus; the build can wait for Sonnet when the app is built.

**Decisions captured for future implementation (do not redo when picking back up):**

- **Result storage:** Supabase atc-test, three new tables (`eval_runs`, `eval_results`, `drift_stats`). Not an external eval platform.
- **Daily 1% production sampling:** Deferred until production has meaningful conversation volume. Re-evaluate when there are 100+ conversations/day.
- **Gate strictness:** Warn-only for the first 30 days after the harness goes live, then flip to blocking. Threshold revisit logged as a follow-up.
- **Scoring strategy:** Hybrid — single Sonnet judge (temperature=0) for standard evals, 3-judge ensemble for safety-critical, single Haiku judge for the 1% sampling once that exists.
- **Self-preference mitigation:** Structured per-criterion verdicts, anonymized response in judge prompt, forced chain-of-thought.
- **Eval hygiene:** Separate Anthropic API key + project for evals; `X-Eval-Suite: true` request header; eval inputs never enter production conversation storage.
- **Regression threshold:** ≥5% OR ≥10 absolute pass→fail flips on standard evals; any single flip on safety-critical. Baseline = median verdict across last 5 main runs.
- **Sampling:** Stratified by persona with floor of 5/day. Only aggregated counts stored — no conversation content in `drift_stats`.
- **Cost target:** ~$240/month assuming 20 PRs/month and Sonnet judge. Switch judge to Haiku for non-safety evals if cost is an issue (cuts to ~$60/month).

**Rejected:**

- Building the harness now with stub responses (like §10, §11) — those stubs gate CI legitimately (a route enumerator works without app code; contract fixtures encode schema). An eval harness with no evals is just empty machinery. No CI value, just maintenance burden.
- External eval platform (Braintrust, LangSmith) — would add $50-200/month vendor cost on top of Anthropic costs, and adds a vendor dependency for a feature that hasn't shipped yet.

**Related artifacts:**
- `docs/evals/design.md` — full design (this PR)
- Future build prompt or §12 redo will reference this when the application code exists

-----

## 2026-05-15 — Auto-updating docs + audience accessibility (v1.1 of help-doc prompts)

### D-014 — Auto-update of docs: AI writes, two-track routing (low-risk auto-merge, structural to human)

**Decision:** When code PRs touch admin-feature paths, a GitHub Action invokes Claude Code to write doc updates automatically. Each proposed change is classified:

- **Low-risk** (word-level edits, paragraph additions, UI label updates, frontmatter changes): auto-commit to the same PR branch as the code change. Ships with the code. No separate human review of the doc edit.
- **Structural** (new files, deleted files, H2 section adds/removes, slug changes, glossary entry add/remove, ≥30% word-count change, or any change below confidence threshold): opens a separate follow-up PR labeled `docs-update-needs-review` for human review.

**Why:** User explicitly chose “zero human review for low-risk changes only; human review for structural changes” after I raised failure-mode concerns with full auto-merge. This compromise preserves engineering velocity for trivial doc keeping while ensuring big shifts get eyes on them.

**Rejected:**

- Full auto-merge with no human review of any doc change — too high failure risk (phantom features, tone drift, stale screenshot references, cross-doc inconsistency).
- PR hard-gate alone (Option A in the discussion) — doesn’t actually do the writing work; engineers can slap a skip label.
- AI-suggested-comments only (Option B) — relies on human to apply the suggestion; user wants automation.
- Nightly drift detection (Option C / D-plus) — catches drift after it has merged; less useful than catching at PR time.

**Related:** Help_Docs_RAG_Ingest_Build_Prompt_v1.md §J–O (in v1.1).

### D-015 — Low-risk auto-merge commits to the same PR branch as the code change

**Decision:** Auto-generated doc updates classified as low-risk are committed to the open PR branch (where the triggering code change lives). Docs ship in the same PR as the code, reviewed in the same surface, merged together. Fallback for already-merged PRs / branch conflicts: open a follow-up PR auto-merged to dev after CI passes.

**Why:** Single review surface. No drift window between code merging and docs catching up. The engineer reviewing the code sees the doc updates and can intervene if anything looks wrong, without it being a separate process step.

**Rejected:**

- Post-merge follow-up commits to dev as default — creates a window (potentially hours or days) where code is shipped but docs are stale.
- Hybrid (try PR branch then fall back) — recommended this in the discussion but user chose the cleaner “always PR branch” approach. The fallback for edge cases (already-merged, conflicts) is preserved as a safety net.

**Related:** Help_Docs_RAG_Ingest_Build_Prompt_v1.md §M routing logic.

### D-016 — Auto-update visibility: GitHub issue (`docs-auto-update-summary`), no Slack

**Decision:** Daily summary of auto-merges is published as a rolling GitHub issue labeled `docs-auto-update-summary`. No Slack integration in v1.

**Why:** GitHub issue persists, is searchable, can be referenced in postmortems, and doesn’t depend on Slack being configured. Slack is ephemeral; bad auto-merges might cause problems weeks later, by which time Slack messages are gone.

**Rejected:**

- Slack-only — ephemeral, dependency.
- Both — Slack adds dependency for no gain over issue alone.
- Git log only — too low-friction to surface patterns.

**Related:** Help_Docs_RAG_Ingest_Build_Prompt_v1.md §M.

### D-017 — Confidence threshold for low-risk classification: 0.65 (looser), revisit after 30 days

**Decision:** Initial confidence threshold for auto-merge eligibility is 0.65. Claude Code self-rates each proposed change on a 0–1 scale; below 0.65 routes to structural (human review) pathway regardless of other criteria.

**Why:** User explicitly chose looser threshold. Rationale (user’s preference): only the messy/ambiguous cases need human review; most edits should flow through automatically. Trade-off: higher chance of low-quality doc edits shipping.

**Mitigations against the trade-off:**

- Daily summary issue (D-016) makes auto-merges visible.
- One-click revert workflow (§M of build prompt v1.1) makes rollback trivial.
- Jargon-checker is enforced regardless of confidence (failures force structural classification).
- Diff sanity check (≥20% deletion forces structural).
- 30-day mandatory threshold review: count auto-merges, count reverts, count post-merge edits. If revert/edit rate >5% of auto-merges, tighten threshold.

**Rejected:**

- 0.85 (conservative) — user wanted looser.
- 0.75 (balanced) — user wanted looser.
- Start 0.85 and tune down — user preferred starting looser.

**Related:** Help_Docs_RAG_Ingest_Build_Prompt_v1.md §L. Threshold value lives in `.github/auto-update-help-docs.config.json` for runtime tuning without code change.

### D-018 — Doc audience reframed for travel agents (not generic SaaS users)

**Decision:** v1.1 of the doc-generation build prompt replaces the generic “SaaS help center” audience reference with a specific persona (“Sarah,” a working travel agent with 15 years of experience, comfortable with Outlook and booking software, never written code or touched DNS). Reference points: Mailchimp, Squarespace, HoneyBook — explicitly NOT Stripe, Linear, GitHub, Notion.

**Why:** Tenant admins on this platform are travel agents, not software professionals. Stripe-level docs would intimidate and confuse them. The original v1 prompt’s reference points (Stripe/Linear/Notion) would have produced docs that read as condescending or alienating to the actual audience.

**Rejected:**

- Keep generic SaaS audience — wrong for this platform’s customers.
- Define the persona but keep Stripe/Linear as references — contradictory; the references shape voice.
- Have writer adapt as needed — too unreliable; specificity matters for voice consistency across 13 files.

**Related:** Help_Docs_Generate_Build_Prompt_v1.md §Audience (in v1.1).

### D-019 — Every doc opens with a “Quick: how to…” section

**Decision:** Every doc (except 12-troubleshooting and 13-glossary) opens with a 5-step (or fewer) ordered list answering the most common task in that doc, before any conceptual setup.

**Why:** Travel agents arrive at help pages wanting to do something specific. They scan; they don’t read. The Quick section serves the 80% case in 30 seconds. Conceptual depth follows for the 20% who need it.

**Rejected:**

- Conceptual-first ordering (the original v1) — leaves the impatient user reading filler before getting to actionable steps.
- Optional Quick section — inconsistency between docs makes the pattern unreliable.

**Related:** Help_Docs_Generate_Build_Prompt_v1.md §Structure (in v1.1).

### D-020 — Hard jargon checker as a quality gate; 13th file added as glossary

**Decision:** v1.1 of the doc-generation prompt adds:

1. An explicit forbidden-words list (CNAME, DNS, API, JSON, JWT, OAuth, RAG, schema, tenant, sub-host, persona, ingestion, deploy, backend, frontend, etc.) with plain-English replacements.
1. A hard quality gate that scans every doc for jargon occurrences; any hit outside a code block or glossary definition fails the build.
1. A 13th file `13-glossary.md` for unavoidable platform terms (Branding, Persona, Custom domain, Tenant, etc.) in friendly definitions.

**Why:** Without explicit constraints, AI drafting trends toward developer-tools writing style. A forbidden-words list with replacements forces the right vocabulary. A glossary is the safety valve for genuinely unavoidable terms.

**Rejected:**

- Persona reframe only, trust the AI — relies on drift-free interpretation across 13 files; unreliable.
- Soft style guide (suggestions) — without enforcement, AI may still slip into jargon.
- Skip glossary, keep 12 docs — leaves no place for unavoidable terms; user would encounter “tenant” in system emails with no friendly explanation.

**Related:** Help_Docs_Generate_Build_Prompt_v1.md §Jargon and §Glossary authoring (in v1.1).

### D-021 — v1 of help-doc prompts updated in place (v1.1) rather than creating v2 / separate prompts

**Decision:** The doc-generation and RAG-ingest prompts were edited in place and version-bumped to v1.1 rather than (a) kept at v1 with new v2 prompts created, or (b) the changes split into a new standalone “Auto-Update Docs” prompt.

**Why:** User explicit choice. Keeps the file count manageable and ensures someone running these prompts always gets the latest behavior. v1 of these prompts was never executed (no work depended on the older version), so in-place update has no migration cost.

**Rejected:**

- Keep v1, create v2 — adds file clutter without benefit since v1 was never executed.
- Separate “Auto-Update Docs” prompt — fragments closely-related concerns (the auto-update workflow needs the same audience persona and jargon rules as the initial generation).

**Related:** Help_Docs_Generate_Build_Prompt_v1.md, Help_Docs_RAG_Ingest_Build_Prompt_v1.md (both now v1.1 internally, same filenames).

-----

## 2026-05-15 — Help docs generation + RAG ingestion (split build prompts)

### D-008 — Help docs split into two separate build prompts

**Decision:** Documentation generation and RAG ingestion are two separate build prompts, executed in order: generate first, then ingest.

**Why:** Different shapes of work. Doc generation is content-authoring with quality review gates. RAG ingestion is a code/infrastructure build with schema changes, tests, and a workflow. Bundling them would create a long, mixed-concern prompt that’s harder to review and harder for Claude Code to plan against.

**Rejected:**

- Single combined prompt — too long, too mixed.
- Generate docs first, ingest as a manual one-off — loses the automated re-ingestion-on-doc-change behavior.

**Related:** Help_Docs_Generate_Build_Prompt_v1.md, Help_Docs_RAG_Ingest_Build_Prompt_v1.md

### D-009 — Both follow-up prompts use Sonnet only (no Opus phase)

**Decision:** Neither the doc generation nor the RAG ingestion prompt uses Opus for planning.

**Why:** Both are well-scoped. Doc generation is a writing task with explicit per-file mapping. RAG ingestion is a clear integration task with known inputs (Markdown files) and outputs (RAG chunks with metadata). Opus’s planning advantage doesn’t pay back here.

**Rejected:**

- Opus-for-planning on the RAG ingestion prompt — considered because it touches schema and retrieval, but the addendum and v6 §6/§22 already specify nearly all the design decisions. Planning is mostly mapping to existing patterns.

**Related:** Both new build prompts state Sonnet-only at the top.

### D-010 — Doc set scope limited to 12 tenant-admin docs in v1

**Decision:** Round 1 of doc generation produces only the 12 admin-facing docs from addendum §3.2. Customer-facing help content is a later pass.

**Why:** User explicit choice. Also pragmatically: customer-facing help has different audience, different tone, and different content. Tackling both at once dilutes quality on both.

**Rejected:**

- Generate broader set including customer-facing — deferred.

**Related:** Help_Docs_Generate_Build_Prompt_v1.md (scope section).

### D-011 — Docs are AI-drafted from specs (no engineer-authored phase)

**Decision:** Claude Code reads the v6 spec and the Self-Service Help addendum and drafts the docs directly. No engineer-authored scaffolding phase.

**Why:** User explicit choice. The specs are detailed enough that AI drafting produces something close to publishable on first pass. Engineering review at the end is still required — this is “AI draft, human review,” not “AI ship.”

**Rejected:**

- Engineer-authored with AI assistance — slower, and the user has chosen to bet on the specs being good enough as a source.
- AI-drafted with explicit human edit pass before publishing — this is implied (no production publishing without review) but not codified as a separate phase in the prompt.

**Related:** Help_Docs_Generate_Build_Prompt_v1.md (authoring standards section).

### D-012 — RAG ingestion target is platform-docs scope only (option a)

**Decision:** Help docs are ingested into the new `platform-docs` RAG scope. They are NOT retrievable by the customer-facing travel concierge persona — only by the Help AI.

**Why:** User explicit choice. Keeps the concierge focused on travel knowledge. Avoids the concierge confidently explaining admin features that customers can’t access (which was flagged as a risk during the question).

**Rejected:**

- Also queryable by concierge — risk of customer-facing AI explaining admin-only features.
- Separate index — adds operational surface without benefit.

**Related:** Help_Docs_RAG_Ingest_Build_Prompt_v1.md (Section B retrieval changes).

### D-013 — Authority feedback loop disabled for platform-docs scope

**Decision:** v6 §6.10 authority feedback (thumbs-down nudges authority down) is explicitly disabled for chunks with `scope = 'platform-docs'`. A thumbs-down on a Help AI answer citing platform-docs means the docs are wrong — that’s an engineering bug, not an authority signal.

**Why:** The docs ARE the source of truth for platform behavior. Nudging their authority based on user feedback creates a feedback loop where users who disagree with how the platform works can erode the documentation’s authority score.

**Rejected:**

- Apply standard feedback loop — wrong epistemic model for source-of-truth content.

**Related:** Help_Docs_RAG_Ingest_Build_Prompt_v1.md (Section D authority scoring).

-----

## 2026-05-15 — Self-Service Help Feature (initial decisions)

**Context:** New tenant-facing feature added to the platform: a Self-Service Help module inside the tenant admin console, plus a parallel customer bug-report path via the travel concierge AI persona.

### D-001 — Self-Service Help spec lives in a standalone addendum doc

**Decision:** Document the Self-Service Help feature in a separate addendum file (`Self_Service_Help_Addendum_v1.docx`) rather than inside the v6 spec doc.

**Why:** The v6 spec is already consolidated and the feature is meaningfully cohesive on its own. A standalone addendum is easier to version, share with reviewers, and reference from build prompts.

**Rejected:**

- Adding as a new Section 32 inside v6 spec — would mean re-issuing the full v6 doc.
- Tucking into an existing section — the feature spans UI, GitHub integration, customer-side flows, and AI; no existing section is a natural home.

**Related:** Self_Service_Help_Addendum_v1.docx

### D-002 — Customer-reported bugs route to the same GitHub repo as tenant-reported bugs

**Decision:** All bugs (from tenant admins, tenant agents, or end customers) open as issues in the same GitHub repo that holds the platform code. Customer-originated bugs carry the label `customer-reported`.

**Why:** Single triage queue. Engineers don’t context-switch between repos. Labels segment the queue for filtering. Aligns with the CI/CD model (one repo, release-branch pipeline).

**Rejected:**

- Separate customer-bugs repo — adds operational overhead, fragments triage.
- Tenant-admin-triages-first model — adds latency, and the AI is already gathering structured info before issue creation, so a human triage step adds cost without clear value at this stage.

**Related:** §10 Customer bug flow in addendum.

### D-003 — Deliverables for this feature: spec addendum + build prompt + MEMORY.md

**Decision:** Produce both a written spec (the addendum) and a build prompt for Claude Code, plus the MEMORY.md file going forward.

**Why:** Spec gives stakeholders something to review. Build prompt gives engineering something to execute. They must agree; the addendum is the source of truth, the build prompt is a derived artifact.

**Rejected:**

- Spec only — would still require translating into actionable engineering work.
- Build prompt only — leaves stakeholders without a reviewable document.

**Related:** Self_Service_Help_Addendum_v1.docx, Self_Service_Help_Build_Prompt_v1.md

### D-004 — Build prompt: start with Opus, switch to Sonnet for implementation

**Decision:** The Claude Code build prompt instructs the agent to use Opus for the initial planning/architecture pass, then switch to Sonnet for implementation, and switch back to Sonnet at end-of-session.

**Why:** Opus has stronger planning chops; the planning phase benefits disproportionately. Implementation is a lot of mechanical work that Sonnet handles well at a fraction of the cost. The switch-back-to-Sonnet-at-end rule comes from standing project instructions.

**Rejected:**

- Sonnet only — fine for size, but planning a feature with cross-cutting GitHub + AI + RLS + UI concerns benefits from Opus.
- Opus only — expensive, and overkill for the implementation grind.

**Related:** Self_Service_Help_Build_Prompt_v1.md (top of file specifies model switches).

### D-005 — Bug auto-fix gating: confidence/clarity threshold + staging reproduction required

**Decision:** Claude Code does NOT attempt a fix on every new bug. Two gates apply:

1. Confidence/clarity score (computed at issue creation from the AI’s information-gathering session) must exceed a threshold.
1. The bug must be reproducible in staging (via the existing CI/CD prod-DB-copy-to-staging pipeline) before any fix is attempted.

If reproduced AND high-confidence: Claude Code opens a draft PR with proposed fix. Production deploy still requires human approval per existing CI/CD gate.

If not reproducible OR low-confidence: human review queue; no auto-PR.

**Why:** The user explicitly chose “confidence threshold” for trigger and “reproduce in staging first” for fix attempts. Both reduce the risk of Claude Code spending tokens or making changes on garbage-quality reports. Adds a self-throttling mechanism on cost. Aligns with existing CI/CD design philosophy (friction by design at high-risk moments).

**Rejected:**

- Auto-fix on every issue — too risky, too expensive, low signal-to-noise.
- Manual-only triggers — defeats the purpose of “self-service” automation.
- Skip staging reproduction — would bypass the safety net the CI/CD pipeline already provides.

**Related:** §9 of addendum (bug evaluation pipeline), §10 (customer bug flow).

### D-006 — Customer bug-reporting requires OAuth authentication

**Decision:** A customer can only report a bug via the AI travel concierge persona if they are signed in (OAuth-authenticated per §17 of v6 spec).

**Why:** Prevents anonymous abuse / spam GitHub issues. The OAuth identity attaches to the issue for follow-up. Anonymous bug reporting is a known spam vector and there’s no real loss to legitimate customers who can sign in.

**Rejected:**

- Public/anonymous customer bug reporting — abuse vector.
- Tenant-admin per-tenant opt-in — adds tenant-side complexity for limited benefit at this stage; can be added later if a tenant requests it.

**Related:** §10 of addendum.

### D-007 — Standing rules established for this project

**Decision:** Apply these rules to all work going forward (captured here so they survive across sessions):

- Flag uncertainty explicitly — never present a guess as fact.
- Show options before acting when unsure.
- Match response length to task complexity; no padding.
- Stop and confirm before significantly altering content already created.
- Only change what was asked; flag other improvements at the end without acting on them.
- Maintain this MEMORY.md; read it at session start.
- Build prompts specify which model to use; Opus prompts must switch back to Sonnet at end.
- Avoid presenting code for the user to review (the user is technical but doesn’t review code).

**Why:** Captured from initial user instructions. Storing here prevents drift across sessions.

**Rejected:** N/A — these are standing rules, not a decision among alternatives.

-----

## 2026-05-16 — CI/CD Pipeline Bootstrap

### D-022 — Production environment required-reviewer gate: added after repo went public

**Decision:** `production` GitHub Environment has jharvieux as required reviewer. Pipeline pauses for manual approval before deploying to production.

**Why:** Initially unavailable — required reviewers only work on public repos or paid plans. Repo was made public during §4 setup, enabling the gate. Added immediately.

**Related:** §2 of ATC CICD Implementation — Build Prompts for Claude Code.md

### D-023 — Scaffold runs before CI/CD pipeline (Option A chosen)

**Decision:** Ran the full Next.js 14 scaffold before starting CI/CD sections, because the repo had no application code.

**Why:** CI/CD sections presuppose an existing app with package.json and src/. Without the scaffold, typecheck/lint/test/build have no target.

**Rejected:** Option B (stub directories only) — cleaner to have a real working app before wiring the pipeline.

**Related:** feature/scaffold branch; merged to dev as PR #1 before §2.

-----

## Open Items (resolve before they go stale)

- **Confidence/clarity threshold value (bug auto-fix)** — the addendum specifies a threshold exists, but the actual number (e.g., 0.7) will be tuned empirically once real bug submissions arrive. Initial value to be set during Phase 1 implementation; recalibrate after 30 days of real data.
- **GitHub Action workflow for bug auto-fix** — needs to be designed alongside or integrated with the existing `.github/workflows/deploy.yml`. Out of scope for the addendum; flagged as a build prompt deliverable.
- **Help documentation source of truth** — addendum specifies docs are Markdown in the repo, rendered onscreen and exportable to PDF/.docx. The initial documentation content itself isn’t written yet; that’s a Phase 1 content task (now covered by Help_Docs_Generate_Build_Prompt_v1.md v1.1).
- **Onboarding flow for first-time tenant admins** — does the Help section get a “first visit” tour? Not decided yet. Default for now: no tour, just discoverable buttons.
- **Auto-update confidence threshold (0.65) — 30-day review** (D-017). Must measure auto-merge volume, revert rate, post-merge edit rate. If revert/edit rate >5% of auto-merges, tighten threshold. Add reminder to a calendar 30 days post-launch.
- **Path-to-doc mapping table tuning** (Help_Docs_RAG_Ingest_Build_Prompt_v1.md §K). Initial mapping is a best guess; will likely need adjustment after first 10–20 real auto-update runs to reduce false-negative misses and false-positive triggers.
- **Jargon list completeness** (Help_Docs_Generate_Build_Prompt_v1.md v1.1). The forbidden-words list is not exhaustive; expect 2–3 rounds of additions as the writer encounters new terms that should have been banned.
- **Travel-agent terminology drift**. If the v6 spec uses “sub-host” and the docs use “your account,” there’s a vocabulary mismatch with system emails and error messages (which use the spec terminology). Either the platform’s UI/email copy needs to be reframed to match the docs (preferred but expensive), or the glossary needs to bridge.