# Build Prompts — Spec v6.2, Part 9 (Section 32)

**This file contains Build Prompt 31 only.** Build Prompt 32 follows in a separate file. Together they cover §32 Self-Service Help.

## How Part 9 builds on Parts 1–7

Part 9’s single section (§32 Self-Service Help) adds the **customer- and tenant-facing self-service surface for support cases** on top of the operationally complete platform from Part 7. By the end of Part 9:

- Tenant admins have a `/admin/help` console with three buttons (I need help / Report a bug / Request a feature) plus a documentation viewer rendering Markdown docs co-located with code at `apps/main/content/help/`. The docs can be downloaded as PDF or Word.
- A new **Help AI persona** runs distinct from the customer-facing travel concierge personas, scoped to platform documentation only. It runs under the existing supervisor (Part 3 Prompt 11) — same kill switch, same audit, same hallucination defense.
- Tenant-side documentation is indexed in the RAG service under a new **`platform-docs` scope**, the single deviation from §6.9’s strict two-level (global / tenant) scope model. Read-only and managed by the release pipeline.
- The Help AI runs three distinct flows — open Q&A, structured bug capture, structured feature request — each generating GitHub issues for the platform engineering team via the GitHub App authentication path.
- The customer-facing travel concierge persona (Part 5 Prompt 24) gains a bug-report intent recognizer that hands off to the Help AI bug flow within the same chat surface, after an OAuth authentication gate.
- A bug auto-fix pipeline triggers on issues meeting a confidence threshold: spins up a fresh staging environment, runs a two-gate reproduction contract (pre-fix MUST fail; post-fix MUST pass), and only on both passing does it open a draft PR. Human review still gates the production deploy.
- A new abuse-monitoring dimension `help_submission_rate` per Part 6 Prompt 27 covers help/bug/feature submission volume with tenant + per-customer limits.

The two Part 9 prompts assume Build Prompts 01–30 are committed.

-----

## Prerequisites added by Part 9

### 1. New cloud services and external dependencies

- **GitHub App** — provisioned in the GitHub organization that owns the platform repo. Required permissions per §32.7.1: Issues (R/W), Pull Requests (R/W), Contents (R/W), Actions (R). Installation ID captured per the platform repo.
- **`docx-js`** — npm package for Word document generation. Build Prompt 31 installs.
- **Puppeteer** — already in place from earlier prompts (Part 5 Prompt 21 quote PDF rendering). Reused here for help docs PDF generation.
- **Claude Code API access** — for the auto-fix pipeline (Build Prompt 32). Operator obtains a separate API key with its own Anthropic Console spending limit per §32.9.6.

### 2. New keys to add to env before Build Prompt 31

```
GITHUB_APP_ID (required)
GITHUB_APP_PRIVATE_KEY (required, secret) — PEM format
GITHUB_APP_INSTALLATION_ID (required)
GITHUB_REPO_OWNER (required)
GITHUB_REPO_NAME (required)
HELP_DOCS_CACHE_TTL_SECONDS (optional; default 3600)
```

The Part 7 Prompt 29 Zod env schema gets extended here. Build Prompt 32 adds the auto-fix-pipeline env vars.

### 3. Decisions to make before Build Prompt 31

- **The platform repo identity.** §32.7.2 says bug and feature issues live in the same GitHub repo as the platform code. Confirm `GITHUB_REPO_OWNER` and `GITHUB_REPO_NAME` reflect production (not a separate help-only repo, per spec).
- **Initial help doc content.** §32.15.2 Phase 1 done definition requires “at least 5 doc sections written and approved.” Operator + product engagement; not blocking code. Build Prompt 31 ships the doc-rendering structure and 1–2 stub doc files; the rest is `// TODO(content)`.

### 4. Open items the spec leaves to implementation

- **Doc set final structure** — the file names in §32.3.2 are explicitly “illustrative; subject to refinement during implementation.” Operator decides which sections actually launch.
- **Screenshot vision-PII detection** — §32.13.2 says “warn, do not block” at launch; data-driven reassessment after 90 days. Build Prompt 31 ships warn-only.
- **Phase 2 customer bug flow** — built in Build Prompt 32, gated behind a feature flag so Phase 1 can ship without it.

-----

## How to use the build prompts below

Same as Parts 1–7. **Both Part 9 prompts call for Opus.** Even though the feature surface is bounded, two pieces are correctness-critical with public exposure: PII redaction before GitHub (a leak ships data into a public-or-semi-public issue tracker) and the two-gate auto-fix reproduction contract (a wrong implementation either rubber-stamps non-fixes or makes engineers disable the gate). Both deserve Opus.

-----

# BUILD PROMPT 31 — Help AI persona, three flows, documentation viewer, GitHub issue creation with PII redaction

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** Two pieces of this prompt are correctness-critical. The §32.7.6 PII redaction before GitHub uses the Part 5 Prompt 22 §22.4 redaction pipeline; running it correctly against the bug-report fields means hooking the same zero-tolerance quarantine path (SSN, full credit card, passport number → DO NOT create the issue; quarantine + alert) and the tolerable-PII redaction (`[REDACTED-NAME]` etc.). A leak from a tenant admin’s help session into a public GitHub issue body is the same shape of compliance event as a CCPA violation. The §32.3.4 `platform-docs` scope is the single deviation from §6.9’s strictly-two-level (global / tenant) RAG model — adding it carelessly (e.g., letting tenants submit to it, or letting the Help AI accidentally retrieve other tenants’ chunks) breaks the §6.9 invariant the whole platform leans on.

**Spec references:** Part 9 §32.1 (purpose and scope), §32.2 (user experience), §32.3 (tenant admin console documentation), §32.4 (Help AI persona — role, system prompt, three flows, cost model), §32.5 (database schema — 4 tables + RLS), §32.6 (API routes), §32.7 (GitHub integration — App auth, repo, labels, issue body format, resilience, PII redaction), §32.8 (confidence and clarity scoring), §32.12 (permissions / role mapping), §32.13 (privacy and security — PII handling, screenshots, audit logging, tenant isolation), §32.14 (environment variables — Phase 1 subset), §32.15.2 (Phase 1 done definition). Depends on Part 3 Prompts 10 + 11 (persona registry + supervisor with kill switch), Part 4 Prompt 18 (`platformAdminClient`, BrandedLayout for docs PDF), Part 5 Prompt 21 (`puppeteer` for PDF rendering, Help AI uses RAG retrieval), Part 5 Prompt 22 (§22.4 PII redaction pipeline — the same pipeline runs against bug-report content), Part 5 Prompt 24 (`assertPermission` patterns), Part 6 Prompt 26 (`withPlatformAdminAudit` for admin-side cross-tenant routes), Part 7 Prompt 29 (Zod env schema — extends here).

**Prerequisite check:** Build Prompts 01–30 are committed. GitHub App provisioned and installed per Part 9 prerequisites. `GITHUB_APP_*` env vars set.

**Goal:** Build the Phase 1 Self-Service Help feature end-to-end: env vars, schema (4 tables with RLS), Help AI persona registered in the existing persona system, three flows (help / bug / feature) with the supervisor wired in, documentation viewer at `/admin/help` rendering Markdown from `apps/main/content/help/`, PDF + Word export with caching, the `platform-docs` RAG scope (read-only, managed by release), GitHub App authentication and issue creation with PII redaction and zero-tolerance quarantine, confidence/clarity scoring, in-flow user-visible score transparency, the resilience pattern (retry on GitHub failure), and the platform-admin triage queues. Stop short of the customer bug flow and the auto-fix pipeline (Build Prompt 32).

**Tasks:**

1. **Env vars — extend Part 7 Prompt 29 Zod schema.** Add to `apps/main/src/lib/env-check.ts`:
   
   ```
   GITHUB_APP_ID (required)
   GITHUB_APP_PRIVATE_KEY (required, secret) — z.string().includes('-----BEGIN') for PEM sanity
   GITHUB_APP_INSTALLATION_ID (required)
   GITHUB_REPO_OWNER (required)
   GITHUB_REPO_NAME (required)
   HELP_DOCS_CACHE_TTL_SECONDS (optional, default 3600)
   BUG_AUTOFIX_CONFIDENCE_THRESHOLD (required, default 0.7) — referenced here so confidence scoring works; actually consumed by Build Prompt 32 auto-fix
   ```
   
   Update `.env.example` to match.
1. **Schema — four tables + RLS.** Migration `apps/main/supabase/migrations/0029_self_service_help.sql`:
- `public.help_sessions` exactly per §32.5.1 schema. Indexes per spec.
- `public.bug_submissions` exactly per §32.5.2 schema. Indexes per spec.
- `public.feature_requests` exactly per §32.5.3 schema. Indexes per spec.
- `public.help_doc_versions` exactly per §32.5.4 schema (PDF/.docx cache table).
- **RLS policies per §32.5.5:**
  - `help_sessions`, `bug_submissions`, `feature_requests`: tenant-scoped via the existing `auth_user_in_tenant()` pattern; platform_super_admin and platform_support roles SELECT across all tenants (handled via `withPlatformAdminAudit` on the admin routes — RLS itself only opens cross-tenant read for these role’s `auth.jwt() -> 'role'` values).
  - Customer access: a customer can SELECT their own `bug_submissions` and `feature_requests` rows (`WHERE submitter_user_id = auth.uid()`).
  - `help_doc_versions`: tenant-scoped if `tenant_id IS NOT NULL`; platform-wide read if `tenant_id IS NULL`.
- Inngest event registry entry (per Part 6 Prompt 26): add `help.session_opened`, `help.session_closed`, `help.bug_submitted`, `help.feature_submitted`, `help.github_issue_creation_failed`. Each `tenant_scoped`.
1. **Help AI persona registration.** In `apps/main/src/lib/personas/registry.ts` (the persona registry from Part 3 Prompt 10):
- Add a new persona entry `help_ai`:
  - `slug = 'help_ai'`
  - `kind = 'platform_help'` (extend the persona `kind` enum if it’s a CHECK — add this value)
  - `display_name = 'Help Assistant'`
  - `base_tone_level = 2` (professional, brief per §32.4.2)
  - **Tenant overrides DO NOT apply to the Help AI persona.** Per §32.4.1: it’s scoped to platform documentation, not tenant business. The persona-prompt builder must check `persona.kind === 'platform_help'` and skip the tenant addendum + display-name override paths entirely.
  - Available tools: only `search_platform_docs` (new — Task 6 implements) and `escalate_to_platform_support` (new — escalates to platform support, not tenant support). Do NOT expose the customer-facing tools (`generate_quote`, `collect_booking_details`, etc.).
- System prompt per §32.4.2:
  - Role: “You are a help assistant for the AI Travel Concierge platform.”
  - Capabilities: search platform docs, gather structured info for bugs/features, escalate to platform support.
  - Boundaries: do not invent feature behaviors; cite docs where possible; if uncertain, say so.
  - Tone: professional, brief, helpful. No marketing language.
  - PII handling: redact any PII the user enters before storing or sending to GitHub.
- The persona is registered platform-wide (no tenant scoping).
1. **Three-flow conversation state.** The Help AI runs three flow types differentiated by `help_sessions.session_type`. Build `apps/main/src/lib/help-ai/flow-controller.ts`:
- **Help flow (`help`):** open conversational Q&A. The Help AI uses the platform-docs RAG retrieval (Task 6). Same supervisor preflight as customer chat. If unable to answer with sufficient confidence (RAG returns no chunks above 0.5 confidence threshold) after 3 user messages: the AI suggests escalation to platform support.
- **Bug flow (`bug`):** structured gathering per §32.4.3. The Help AI asks the seven prompts in order, one at a time, persisting answers to a working `BugDraft` state object kept in the conversation. After all answers gathered: compute confidence score (Task 8); present a summary; allow user to edit before submit. On submit: trigger GitHub issue creation (Task 9).
- **Feature flow (`feature`):** lighter-weight structured gathering per §32.4.3 (4 prompts). On submit: GitHub issue with `feature-request` label.
- Flow state machine: each flow has explicit states (e.g., bug flow: `gathering_location → gathering_actual → gathering_expected → gathering_steps → gathering_frequency → confirming_environment → optional_screenshots → showing_summary → submitted`). The current state is held in the conversation context and used by the prompt builder to inject the right next question.
1. **Help AI under the supervisor.** Per §32.2.3 “All Help AI chats run through the supervisor (v6 §10).” Wire the Help AI conversation handler to invoke the same supervisor preflight from Part 3 Prompt 11:
- Same hallucination check (Help AI claims should be grounded in `platform-docs` RAG chunks; ungrounded claims trigger regeneration).
- Same kill switch — if `platform_settings.ai_kill_switch_engaged = TRUE`, the Help AI returns the same fallback message as customer chat.
- Same audit trail (`messages` and `conversations` rows, supervisor findings persisted).
- The supervisor preflight call uses Haiku per the established pattern; the Help AI response itself uses Sonnet per §32.4.4.
- **Cost attribution per §32.4.4 + Part 6 Prompt 27:** Help AI calls attribute to the tenant whose user is interacting via the instrumented `instrumentedClaudeCall` wrapper. The `purpose` enum gets two new values (extend the Part 6 Prompt 27 CHECK constraint): `help_ai_main` and `help_ai_supervisor`.
1. **`platform-docs` RAG scope — single deviation from §6.9.** This is the careful part.
- On the RAG service side (`apps/rag/`): extend the `knowledge_chunks.scope` CHECK constraint to include `'platform-docs'`. Document the deviation in MEMORY with the §32.3.4 rationale.
- Add a new admin-only RAG endpoint: `POST /api/admin/ingest/platform-docs` (RAG service side) — accepts a batch of chunks with `scope='platform-docs'`, ingested under the same authority/recency framework but without tenant_id (NULL). Auth: requires the inter-service JWT (Part 3 Prompt 09) PLUS a header `X-Platform-Docs-Source: release-pipeline` (the release pipeline is the only caller; document in MEMORY that this header is operational discipline, not a security control — the JWT is the security control).
- Read path: when the Help AI calls the retrieval endpoint, it passes `scope_filter='platform-docs'`. The retrieval code returns ONLY `platform-docs` chunks; never returns global or tenant chunks for Help AI queries. Verify this with an integration test: a Help AI query with a deliberately-leading prompt (e.g., asking about a specific tenant’s commission rate) returns no tenant-scoped chunks.
- Tenant admins cannot submit to `platform-docs`. The existing RAG submission UI from Part 5 Prompt 22 must NOT show the scope as an option. Update the submission flow to omit `platform-docs` from any scope selector.
- Build a CLI tool `apps/main/scripts/sync-help-docs-to-rag.ts`:
  - Reads all files under `apps/main/content/help/`.
  - For each file: splits into ~500-token chunks following the same chunking approach from Part 3 Prompt 09.
  - Computes embeddings via OpenAI (using the instrumented wrapper from Part 6 Prompt 27 with `purpose='embedding'` and `tenant_id=PLATFORM_TENANT_ID`).
  - Ingests via the `POST /api/admin/ingest/platform-docs` endpoint.
  - Idempotent: chunks include a `content_hash`; re-running the sync UPSERTs unchanged chunks and replaces changed ones.
- The CLI tool is invoked by the release pipeline (out of scope per CI/CD; documented in MEMORY as a release-pipeline integration point).
1. **Documentation viewer UX — §32.2.2, §32.3.** Build the `/admin/help` route family:
- `/admin/help` — default view: documentation viewer.
  - Left sidebar: nav listing all sections (titles from each `.md` file’s front-matter).
  - Right pane: rendered HTML of the selected section.
  - Search bar across all docs: simple full-text via Postgres `to_tsvector` over a precomputed search-index table, OR an in-memory client-side fuzzy search (operator picks; document in MEMORY).
  - Three buttons in the header: “I need help” / “Report a bug” / “Request a feature”. Each opens a slide-over chat panel (Task 11).
- `/admin/help/print` — single-page render of all docs concatenated with print-friendly CSS (`@media print`). User invokes browser print.
- `apps/main/content/help/`:
  - Ship 1–2 stub `.md` files at launch as scaffolding (e.g., `01-getting-started.md`, `12-troubleshooting.md`) with `// TODO(content)` markers. The other 10 files from §32.3.2 are operator content tasks.
  - Each file has YAML front-matter: `title`, `slug`, `order`, `category`.
- Markdown rendering via `remark` + `rehype` per §32.3.3.
1. **PDF and Word export — §32.3.3.** Build:
- **PDF generation:** Inngest function `help-docs-pdf-generate` triggered by `POST /api/help/docs/export` with `{ format: 'pdf' }`:
  - Concatenates all Markdown files in `order` per front-matter.
  - Renders HTML via remark/rehype.
  - Uses Puppeteer (already available from Part 5 Prompt 21 quote PDFs) to render to PDF.
  - Applies tenant branding header (logo + business name) if `tenant_branding` row exists; otherwise default platform branding.
  - Uploads to Supabase Storage at `tenant_{tenant_id}/help-docs/{code_version}-{format}.pdf`.
  - UPSERTs `help_doc_versions` row with `code_version`, `tenant_id`, `format='pdf'`, `storage_path`, `expires_at = NOW() + HELP_DOCS_CACHE_TTL_SECONDS`.
  - Returns a signed URL valid 1 hour.
- **Word generation:** same shape using `docx-js` to convert HTML → DOCX. Cached the same way.
- **Cache lookup before regenerating:** `GET /api/help/docs/export/:jobId` checks the cache first by `(code_version, tenant_id, format)`. If a row exists with `expires_at > NOW()`: return the cached signed URL. Otherwise the export job runs.
- **Cache invalidation:** on every deploy the `code_version` changes (read from `process.env.VERCEL_GIT_COMMIT_SHA` or equivalent). Old cache rows naturally expire and a cleanup cron `help-doc-versions-purge` running daily deletes rows where `expires_at < NOW() - 7 days`.
1. **GitHub App authentication.** Build `apps/main/src/lib/github/auth.ts`:
- `getInstallationToken(): Promise<string>` — generates an installation access token using the GitHub App ID + private key + installation ID. JWT signed with RS256; exchanged for an installation token via GitHub’s API.
- Tokens cached in-process for 50 minutes (GitHub installation tokens live for 1 hour; refresh 10 minutes early).
- The token is **never persisted to disk or DB** — in-memory only per request lifecycle.
- Lint rule from Part 6 Prompt 26: `no-direct-octokit-import` — only `apps/main/src/lib/github/auth.ts` and the issue-creation module (Task 10) may import `@octokit/*`. Other callers go through the wrapper. Same hard-fail pattern.
1. **GitHub issue creation with PII redaction.** Build `apps/main/src/lib/github/issues.ts`:
- `createBugIssue(bug_submission): Promise<{ issue_number, issue_url }>` — wraps the full creation flow:
   1. **Run §22.4 PII redaction over every free-text field** (`where_in_platform`, `actual_behavior`, `expected_behavior`, `steps_to_reproduce`):
     - **Regex pass first (zero-tolerance):** SSN, Luhn-validating credit card, passport number patterns. On match: throw `PIIZeroToleranceQuarantineError` with the matched field name. The caller (`POST /api/help/bugs`) catches this, sets `bug_submissions.github_issue_state = 'failed'`, writes the trigger field to `github_creation_error`, alerts platform admin via existing notification path. **Do NOT create the issue.**
     - **Haiku redaction pass for tolerable PII:** names, emails, phone numbers — replace with `[REDACTED-NAME]`, `[REDACTED-EMAIL]`, `[REDACTED-PHONE]`. The redacted text is what gets posted to GitHub AND what gets persisted in `bug_submissions` (per §32.13.1 “redacted form is stored; raw form is discarded”).
   1. **Strip EXIF from screenshot attachments** (per §32.13.2). If a Haiku vision-PII pass is wired (warn-only at launch per §32.15 Phase 3): on detection, attach the screenshot WITH a warning comment in the issue body; do NOT block.
   1. **Build the issue body** per §32.7.4 with all required fields. Hash the `tenant_id` for the visible portion (`tenant_id_hash = sha256(tenant_id + PLATFORM_PEPPER).slice(0,12)`, reusing the Part 6 Prompt 25 PLATFORM_PEPPER). The plaintext `tenant_id` stays only in `bug_submissions`.
   1. **Labels:** `bug`, plus `tenant-admin-reported` or `customer-reported` based on `source_type`. If confidence_score >= `BUG_AUTOFIX_CONFIDENCE_THRESHOLD`: also `auto-fix-candidate`. Otherwise: `pending-human-review`.
   1. Call GitHub Issues API with the installation token. On success: write `github_issue_number`, `github_issue_url`, `github_issue_state='open'`. On failure: throw `GitHubAPIError` — caller handles per §32.7.5 resilience.
- `createFeatureIssue(feature_request)` — same shape, lighter body, label `feature-request` plus `tenant-admin-reported` or `customer-reported`.
- `closeIssue(issue_number, reason)` — for the resolution-notification flow (Task 14).
1. **Help AI chat surface — slide-over panel.** Build `apps/main/src/components/help-ai/HelpAIPanel.tsx`:
- Visual: slide-over from right, ~480px on desktop, full-screen on mobile.
- Header: current flow type (Help / Bug / Feature), close button.
- Body: conversation messages (same render component as customer chat from Part 5 Prompt 24).
- Footer: input + send + “Escalate to platform support” button (visible only in `help` flow).
- **Streaming AI responses** via SSE — same pattern as customer chat.
- **Open via:** the three buttons on `/admin/help` create a new `help_sessions` row via `POST /api/help/sessions` and open the panel with the returned `session_id`.
1. **API routes — §32.6.** All wrapped in `assertPermission()` with the appropriate role gate per §32.12 role mapping:
- `GET /api/help/docs` — list sections (titles, slugs).
- `GET /api/help/docs/:slug` — get single doc section as HTML.
- `GET /api/help/docs/search?q=...` — search docs; returns matching sections with snippets.
- `POST /api/help/docs/export` — trigger PDF/Word generation; returns job_id.
- `GET /api/help/docs/export/:jobId` — poll export status; returns signed URL when ready.
- `POST /api/help/sessions` — open session; body `{ session_type, source_surface }`; returns session_id.
- `POST /api/help/sessions/:id/message` — send user message; returns SSE stream.
- `POST /api/help/sessions/:id/close` — close session with outcome.
- `POST /api/help/sessions/:id/escalate` — escalate to platform support (writes to `help_sessions.escalated_to_human=TRUE`, fires an alert via the existing notification path).
- `POST /api/help/bugs` — submit a bug; calls `createBugIssue` async via Inngest; immediately returns the `bug_submissions.id`; the issue creation runs in the background with retry.
- `GET /api/help/bugs/:id` — get submission state including GitHub link.
- `GET /api/help/bugs` — list submissions for the current tenant (RLS-enforced).
- Equivalents for `/api/help/features/*`.
- Platform admin cross-tenant routes per §32.6.5 — all wrapped in `withPlatformAdminAudit` with `reason = 'help_admin_view'`:
  - `GET /api/admin/help/sessions` — cross-tenant view.
  - `GET /api/admin/help/bugs` — cross-tenant view.
  - `GET /api/admin/help/features` — cross-tenant view.
  - `PATCH /api/admin/help/features/:id` — set `decision` on a feature request.
1. **Confidence and clarity scoring — §32.8.** Build `apps/main/src/lib/help-ai/confidence-scorer.ts`:
- After the bug flow finishes gathering: the Help AI emits a structured assessment via Haiku call with prompt: “Given this bug report’s structured fields, return JSON `{ specificity_of_location, clarity_of_actual_behavior, clarity_of_expected_behavior, completeness_of_steps, reproducibility_signal, environment_completeness }` each as a number 0-1, plus a brief rationale per factor.”
- Compute `confidence_score = average(all six factors)` per §32.8.2 uniform weighting (v1).
- Persist factors as `bug_submissions.confidence_factors` JSONB.
- **Score transparency to user — §32.8.4:** before submission, show the user their score with a brief per-factor breakdown. The user can revise the gathering and resubmit before the GitHub issue is created.
- **Customers do NOT see the score** — they see only “submitted” confirmation. The score is computed but hidden from the customer-facing UI (relevant in Build Prompt 32).
1. **Issue creation resilience — §32.7.5.** When GitHub issue creation fails:
- `bug_submissions.github_issue_state = 'pending'` (already default).
- Background Inngest function `github-issue-retry` retries with exponential backoff (1m, 5m, 30m, 2h, 8h, 24h).
- After 24 hours of failure: set `github_issue_state = 'failed'`; write `github_creation_error`; alert platform admin via in-app notification; show the submitting user an in-app banner: “We had trouble filing your report. Our team has been notified.”
- **Resilience for zero-tolerance quarantine:** if the redaction step throws `PIIZeroToleranceQuarantineError`, this is NOT retried — the submission goes straight to `'failed'` with a specific error code (`pii_zero_tolerance_quarantined`) and alerts platform admin with category `bug_report_pii_quarantine`. The user sees: “Your report contains information we can’t process safely. Please contact platform support directly.”
1. **Permissions — §32.12 role mapping.** Update the role-mapping table from earlier prompts. Tenant roles (`tenant_owner`, `tenant_agent`, `tenant_billing_admin`): all can view docs, use help flow, submit bugs and features. Customer (authenticated, anonymous): no access at Phase 1 — customer bug flow ships in Build Prompt 32 behind a feature flag. Platform admin roles: cross-tenant view per §32.12.
1. **Platform admin triage queues — §32.6.5 + §32.7.3 labels.** Build `/admin/help-triage`:
- Tabs:
  - **Bug submissions:** list of `bug_submissions` across all tenants. Filter by `github_issue_state`, label, confidence_score range. Click into a row → detail page showing the GitHub issue link, the full structured fields, the help session conversation (read-only).
  - **Feature requests:** same shape. Each row has the decision action (Accept / Reject / Defer / Duplicate) with notes. Decision writes back via `PATCH /api/admin/help/features/:id` and updates the GitHub issue label.
  - **Help sessions:** list of `help_sessions` across tenants. Useful for forensic review when a bug submission needs context.
- All views wrapped in `withPlatformAdminAudit`.
1. **Audit logging — §32.13.3.** Every audited event per §32.13.3:
- Help session opened, closed, escalated → `audit_log` rows.
- Bug or feature submitted → the submission rows themselves serve as the audit (no duplicate `audit_log` rows).
- GitHub issue creation success and failure → `audit_log` rows with `action = 'github.issue_created'` / `'github.issue_creation_failed'`.
- PII zero-tolerance quarantine → `audit_log` row with `action = 'help.pii_zero_tolerance_quarantine'`.
- Platform admin override (`needs-human-fix` label applied) — Phase 2; document the future hook.
- Feature request decision → `audit_log` row.
- All retain per the Part 6 §26.5 7-year audit-log retention.
1. **Tenant isolation tests — §32.13.4.** Add test cases to the cross-tenant route probe from Part 7 Prompt 30:
- Tenant A user attempting `GET /api/help/bugs/:id` where the bug belongs to tenant B → 403; response body does NOT leak tenant B identifiers.
- Same for `feature_requests` and `help_sessions`.
- GitHub-side: the issue body includes the hashed tenant ID. A test confirms the hashing function is deterministic (same input → same hash) AND the plaintext tenant_id is NEVER in the issue body.
1. **Tests.**
- **Schema RLS:** tenant A user cannot SELECT tenant B’s `bug_submissions` row.
- **Customer access:** an authenticated customer SELECTs their own `bug_submissions` but not another customer’s in the same tenant.
- **Help AI persona registration:** the persona renders with the correct system prompt; tenant addendum is NOT applied; display name override is NOT applied even if tenant_branding has one.
- **Help AI under supervisor:** kill switch engaged → Help AI returns fallback message; supervisor hallucination check fires on an ungrounded claim → regeneration triggered.
- **`platform-docs` scope isolation:**
  - A Help AI retrieval call with `scope_filter='platform-docs'` returns only platform-docs chunks; never tenant or global chunks.
  - A customer-facing persona retrieval call NEVER returns platform-docs chunks (the retrieval code excludes them unless `scope_filter` explicitly requests).
  - The RAG submission UI does NOT show `platform-docs` as a scope option for tenants.
- **Bug flow happy path:** all seven fields gathered → confidence score computed → user-visible summary → submit → GitHub issue created with the structured body → labels applied.
- **PII redaction zero-tolerance:** a bug body containing `123-45-6789` (SSN pattern) triggers `PIIZeroToleranceQuarantineError`; the GitHub issue is NOT created; `bug_submissions.github_issue_state='failed'`; admin alert fired; user sees the friendly error message.
- **PII redaction tolerable:** a bug body containing an email is replaced with `[REDACTED-EMAIL]` in both the persisted row AND the GitHub issue body.
- **Confidence scoring:** a high-quality bug (specific location, clear behavior, complete steps) scores > 0.7; a vague bug scores < 0.5.
- **GitHub resilience:** simulate GitHub API 500; the retry job picks up; after 24 hours of failure the row goes to `'failed'` and the admin is alerted.
- **PDF export:** triggering an export for tenant A produces a PDF cached at the right key; tenant A immediately retrieving uses the cache; tenant B requesting the same `code_version` gets their own tenant-branded PDF (not tenant A’s).
- **Tenant ID hashing in GitHub issue:** the issue body contains `tenant_id_hash`; the plaintext `tenant_id` UUID is NOT in the body.
1. **Add to MEMORY.md at end of run:**
- The `platform-docs` scope is the single deviation from §6.9’s strict two-level RAG scope model. It is read-only and managed by the release pipeline via `sync-help-docs-to-rag.ts`.
- The Help AI persona has `kind='platform_help'` and bypasses tenant addendums + display-name overrides at the prompt-builder level.
- GitHub App authentication: tokens are in-memory only, refreshed 10 minutes before expiry. The `no-direct-octokit-import` lint rule restricts SDK imports to `apps/main/src/lib/github/`.
- The `tenant_id_hash` formula uses `sha256(tenant_id + PLATFORM_PEPPER).slice(0,12)` per Part 6 Prompt 25 PLATFORM_PEPPER. Deterministic; never rotates with the pepper itself per the pepper rotation rule.
- Two new `purpose` enum values added to `ai_call_log.purpose`: `help_ai_main`, `help_ai_supervisor`.
- Inngest event registry extended with five new `tenant_scoped` events.
- Search implementation choice (full-text vs client-side fuzzy) — operator picks; document chosen approach.
- The `sync-help-docs-to-rag.ts` CLI is a release-pipeline integration point — invoke from the existing pipeline; the pipeline ownership is in the separate CI/CD spec.
- Customer-facing flow is NOT shipped in Phase 1; it’s gated behind feature flag for Build Prompt 32.

**Definition of done:**

- Tenant admins can navigate to `/admin/help`, view docs, search docs, download PDF, download Word.
- Three buttons open the Help AI slide-over panel with the right flow type.
- Each flow’s state machine drives the conversation through gathering and submission.
- Help AI calls run through the supervisor with the same hallucination check, kill switch, and audit pattern as customer chat.
- The `platform-docs` RAG scope returns only platform docs; no cross-scope leakage.
- Bug submissions go through the §22.4 PII redaction pipeline; zero-tolerance triggers quarantine; tolerable PII is redacted before GitHub.
- GitHub issues are created with structured body, labels, and hashed tenant_id. Plaintext tenant_id is never in the issue body.
- Resilience: GitHub failures retry up to 24 hours; eventual failures alert admin.
- Confidence scoring runs; users see their score before submitting; customers (Phase 2) do not.
- Platform admin triage queues surface submissions across tenants.
- §32.15.2 Phase 1 done definition gates are satisfied (at least 5 doc sections written by operator — code structure supports any number; PII redaction verified by submitting a test bug containing a fake SSN — the test in Task 19 covers this).
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:migrations` all pass.

**After completion:** MEMORY.md entry per Task 20.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```