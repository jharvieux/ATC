# Build Prompts — Spec v6.2, Part 9 (continued)

**This file contains Build Prompt 32 only.** Prompt 31 was in the prior file. Build Prompt 33 (addendum) follows in `build-prompts-33.md`.

-----

# BUILD PROMPT 32 — Phase 2: customer bug flow, help-submission abuse dimension

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** The §32.10 customer bug flow lands in the same PII redaction pipeline as Phase 1 with the same compliance stakes, but the PII surface is larger: the conversation handoff preserves context, so anything the customer said about themselves earlier in the travel-concierge conversation — before they requested a bug report — is in scope for redaction before it reaches a public GitHub issue. A miss there is the same shape of compliance event as a CCPA violation. The §32.11 abuse-monitoring `help_submission_rate` dimension extends Part 6 Prompt 27’s five-dimension framework, but with per-DAY (not per-billing-period) reset semantics plus an independent per-customer rate limit — a wrong state machine either fails to throttle abuse or wrongly blocks legitimate tenants. Each piece is the kind of correctness work that, when wrong, produces silent failure modes.

**Spec references:** Part 9 §32.10 (customer bug flow — trigger detection, authentication gate, flow handoff, issue creation, customer confirmation, confidence scoring, resolution recording), §32.11 (abuse monitoring — new dimension, initial thresholds, cost attribution, per-customer rate limit), §32.13.2 (screenshot vision-PII — warn vs block phase decision), §32.14 (env vars — Phase 2 additions), §32.15.3 (Phase 2 done definition), §32.16 (calls worth flagging). Depends on Part 5 Prompt 24 (customer travel-concierge persona — extended here with bug intent recognizer), Part 5 Prompt 22 (PII redaction pipeline), Part 6 Prompt 27 (abuse-monitoring framework — five dimensions; this prompt adds the sixth), Build Prompt 31 (Help AI persona + bug flow + GitHub issue creation — reused here for customer-side flow).

**Prerequisite check:** Build Prompts 01–31 are committed. The Phase 1 Help AI flows are live for tenant admins.

**Goal:** Build the Phase 2 additions: env vars, customer bug flow triggered by the travel concierge intent recognizer with OAuth gate and chat-surface handoff, the abuse-monitoring `help_submission_rate` dimension with per-customer rate limit, the slim issue-closure webhook that records resolution on the platform side, and the Phase 2 feature flag that gates customer-side until launch.

**Tasks:**

1. **Env vars — extend the Zod schema.** Add to `apps/main/src/lib/env-check.ts`:
   
   ```
   PHASE_2_CUSTOMER_BUG_FLOW_ENABLED (optional, default false) — feature flag
   CUSTOMER_BUG_PER_DAY_LIMIT (optional, default 5) — per-customer per-day bug submissions
   ```
   
   Update `.env.example` to match. The feature flag default of `false` means customer-side ships dark until launch; operator flips to `true` per the §32.15 Phase 2 alignment.
1. **Schema — abuse monitoring extension.** Migration `apps/main/supabase/migrations/0030_help_abuse_monitoring.sql`:
- Extend `tenant_usage_metrics` from Part 6 Prompt 27: add columns `help_submission_count INTEGER NOT NULL DEFAULT 0`, `help_submission_limit_state TEXT NOT NULL CHECK (help_submission_limit_state IN ('ok','soft1','soft2','hard')) DEFAULT 'ok'`, `help_submission_state_changed_at TIMESTAMPTZ`.
- Extend the Part 6 Prompt 27 `tenant_usage_overrides` `dimension` CHECK to allow `'help_submission_rate'`.
- Add a per-customer rate limit table: `public.customer_bug_submission_counters`:
  - `id UUID PK`, `user_id UUID NOT NULL REFERENCES users(id)`, `tenant_id UUID NOT NULL REFERENCES tenants(id)`, `day_anchor DATE NOT NULL`, `submission_count INTEGER NOT NULL DEFAULT 0`, `last_submission_at TIMESTAMPTZ`, `UNIQUE (user_id, tenant_id, day_anchor)`.
  - RLS: tenant-scoped reads; service-role writes.
  - Index: `customer_bug_submission_counters (user_id, day_anchor DESC)`.
- **Inngest event registry entries:** `help.customer_bug_triggered`, `help.customer_bug_completed`, `help.issue_closed`. All `tenant_scoped`.
1. **Travel concierge bug-intent recognizer — §32.10.1.** Extend the Part 5 Prompt 24 customer chat handler:
- Add a deterministic phrase-match pre-check on every user message looking for bug-report intent triggers: `this is broken`, `something's wrong`, `i think there's a bug`, `this page is glitching`, `the website crashed`, plus an extensible regex list in `platform_settings.bug_intent_phrases` JSONB (operator can refine).
- On match: the travel concierge response begins with the §32.10.1 prompt: “It sounds like something might not be working right. Would you like me to file a bug report? I’ll ask you a few quick questions and our engineering team will take a look.”
- The response includes a structured action button rendered in the chat UI: `[Yes, file a bug]` / `[No, just keep helping]`.
- **Feature flag gate:** the whole intent recognizer is gated behind `PHASE_2_CUSTOMER_BUG_FLOW_ENABLED`. When false, no bug offer surfaces; the travel concierge responds normally to the user message.
- When the recognizer is suppressed (false-positive heuristic: tenant has disabled the feature on `tenant_settings.customer_bug_flow_enabled` — operator-confirmable, default TRUE when platform flag is TRUE — but tenants can opt their customers out), the response continues normally.
1. **OAuth authentication gate — §32.10.2.** When the customer clicks `[Yes, file a bug]`:
- If the customer is already OAuth-authenticated: proceed to flow handoff (Task 5).
- If anonymous: the chat surface renders a sign-in prompt inline. Auth flow uses the existing OAuth path from Part 4 Prompt 19. Conversation context preservation uses the anonymous-to-authenticated transfer from Part 3 Prompt 12 — the in-progress conversation messages migrate to the authenticated user’s history.
- **If the customer declines to sign in:** the travel concierge offers the §32.10.2 alternative: “Would you like me to summarize the issue and forward it to a human agent at {tenant_business_name}?” Routes to the existing topic-level escalation from Part 3 Prompt 11 §10.3 — NOT to GitHub. The customer’s feedback reaches the tenant agent via the standard escalation surface (Part 5 Prompt 24 §24.10).
- All three paths (authenticated continue, sign-in then continue, decline and escalate) write `audit_log` rows.
1. **Customer bug flow handoff — §32.10.3.** After authentication confirmed:
- The chat surface shows a subtle banner: “Bug report mode” (visual differentiation per §32.10.3).
- The Help AI bug flow from Build Prompt 31 takes over **within the same conversation** (not a new chat panel). The flow controller from Prompt 31 has a new `source_surface = 'customer_chat'` mode that:
  - Adapts the question wording to customer-friendly phrasing per §32.10.3:
    - “Where were you when you noticed this?” instead of “Where in the platform”.
    - “What happened?” / “What did you expect to happen?” / “Can you walk me through exactly what you did?” / “Did this happen once, or has it happened more than once?” / “I’ll grab your browser info — does this look right?” / “Want to send a screenshot? Drag it into the chat or upload.”
  - Persists answers to the same `bug_submissions` table with `source_type = 'customer'`.
  - The `help_sessions` row has `source_surface = 'customer_chat'` and `conversation_id` populated to link back to the travel concierge conversation.
- On submit: same PII redaction pipeline from Build Prompt 31, same `createBugIssue` from Build Prompt 31’s `apps/main/src/lib/github/issues.ts`, same GitHub App authentication.
- **Per-customer rate limit check (Task 9)** runs BEFORE submission. If exceeded: polite refusal per §32.11.4 “You’ve reported a few issues today already…”.
- Labels applied: `bug` + `customer-reported` (not `tenant-admin-reported`). Triage labels are applied later during interactive triage (§32.9), not at submission.
1. **Issue body adjustments for customer-reported — §32.10.4.** Update the issue body builder in `apps/main/src/lib/github/issues.ts`:
- `submitter_user_id` (customer’s `user_id`) is NEVER exposed in the public issue body — only stored in `bug_submissions`.
- The `tenant_slug` (already hashed in the visible portion via the Part 6 Prompt 25 PLATFORM_PEPPER hashing from Prompt 31 Task 10) appears so engineering can identify the affected tenant.
- Source line in the body: `Source: customer-reported, tenant {tenant_id_hash}`.
- The customer’s raw text (post-PII-redaction) appears verbatim per §32.10.4.
1. **Customer confirmation UI — §32.10.5.** After the GitHub issue is created (or queued for retry):
- The travel concierge responds: “Thanks — I’ve sent that to the engineering team. You’ll hear back if we need more info.”
- The customer does NOT see the GitHub issue URL. They see a friendly reference ID computed from `bug_submissions.id` (e.g., `BR-` followed by 8 base32 chars derived from the UUID).
- The `[Yes, file a bug]` mode banner clears; the travel concierge returns to normal mode.
1. **Issue-closure recording — §32.10.7.** Customers are NOT notified when their reported issue is closed (§32.10.7; §32.1.2 places issue-lifecycle notifications out of scope). The platform still records closure for its own status surface:
- Webhook handler: `POST /api/webhooks/github` validates the signature (GitHub App webhook secret), parses GitHub `issues.closed` events, and looks up `bug_submissions WHERE github_issue_number = event.issue.number`.
- On match: write `bug_submissions.github_issue_state = 'closed'`, `closed_at = NOW()`, and `resolution_summary` (truncated from the GitHub issue’s closing comment if present, otherwise blank). Emit `help.issue_closed`.
- **No in-app notification, no email, no customer-facing message.** The §32.6.3 status route reflects the closed state for tenant admins and platform staff; the customer is not notified. The submission confirmation (§32.10.5) already set the expectation that the customer is contacted only if more information is needed.
1. **Per-customer rate limit — §32.11.4.** Build `apps/main/src/lib/help-ai/customer-rate-limit.ts`:
- `checkCustomerBugLimit(user_id, tenant_id): { allowed: boolean, count_today: number }`:
  - UPSERTs `customer_bug_submission_counters` row for `(user_id, tenant_id, CURRENT_DATE)`.
  - Reads current `submission_count`.
  - Compares to `CUSTOMER_BUG_PER_DAY_LIMIT` (default 5).
  - Returns `allowed = submission_count < limit`.
- On submit attempt that exceeds the limit: the travel concierge responds with the §32.11.4 message: “You’ve reported a few issues today already — our team will get to them. Try again tomorrow if you find something else.” The submission does NOT proceed; no `bug_submissions` row is created.
- **The increment happens on successful submission, not on attempt.** A submission that hits PII zero-tolerance quarantine does NOT count against the per-customer limit (per §32.13 spirit: the customer is being told their report had unprocessable content; rate-limiting them on top is bad UX).
1. **`help_submission_rate` abuse dimension — §32.11.** Extend the Part 6 Prompt 27 framework:
- **Threshold resolver** (`apps/main/src/lib/abuse/thresholds.ts`): add a sixth dimension `help_submission_rate`. Initial values per §32.11.2:
  - `soft1 = 20` submissions per day per tenant.
  - `soft2 = 50` submissions per day per tenant.
  - `hard = 100` submissions per day per tenant.
- These initial thresholds are tier-independent (per §32.11.2 they are flat values), but override support per Part 6 Prompt 27 Task 5 still applies.
- **Counter increments** (`apps/main/src/lib/abuse/counters.ts` extension): every successful `bug_submissions` or `feature_requests` insert increments `tenant_usage_metrics.help_submission_count`.
- **State machine** (`apps/main/src/lib/abuse/state-machine.ts`): same monotonic-within-billing-period semantics from Prompt 27. After each increment, `checkStateTransitionIfNeeded(tenant_id, 'help_submission_rate')` runs.
- **Wait — the abuse counter resets per §32.11.2 “Per-tenant per-day submission counts.”** The dimension is per-DAY, not per-billing-period. This is different from the other five dimensions! The state machine must reset `help_submission_count` and `help_submission_limit_state` daily at 00:00 UTC, NOT at billing-period rollover. Document this divergence in MEMORY.
- Build Inngest cron `help-submission-daily-reset` running at 00:05 UTC: UPDATE `tenant_usage_metrics SET help_submission_count = 0, help_submission_limit_state = 'ok', help_submission_state_changed_at = NULL` for ALL tenants. The state resets cleanly; new submissions advance state through the day.
- **Enforcement per §32.11.2:**
  - `soft1`: in-app banner to platform admin. No tenant notification. Just visibility.
  - `soft2`: email to tenant owner. Throttle submissions for that tenant to 1 per 10 minutes (next submission attempt within 10 minutes returns a friendly refusal in the Help AI: “We’re receiving a lot of reports from your tenant. Please wait a few minutes before submitting another.”).
  - `hard`: block all further help/bug/feature submissions for the tenant for the rest of the day. The Help AI panel shows a banner: “Help submissions paused until tomorrow. Please contact platform support directly if urgent.” Platform admin alert fires.
1. **Screenshot vision-PII — §32.13.2 phase-aware behavior.** Build `apps/main/src/lib/help-ai/screenshot-pii-detector.ts`:
- On screenshot upload during a bug flow: run a Haiku vision call asking “Does this image contain personally-identifying information (faces, license plates, ID documents, financial data, screen content with PII)? Return JSON `{ detected: boolean, categories: string[] }`.”
- **Phase 2 behavior: warn-only.** If detected: show the user a warning banner: “This image may contain personal information. Are you sure you want to attach it?” with `[Continue] [Replace]` buttons. Continue → attach as normal.
- **Phase 3 behavior** (operator flips a flag `platform_settings.screenshot_pii_block_mode = TRUE` after 90 days of data evaluation): refuse upload and ask the user to redact and re-upload. This is operator-controllable without a code deploy.
- Either way: EXIF metadata is stripped on upload (already done in Build Prompt 31 Task 10 step 2).
1. **Phase 2 done definition checks — §32.15.3.** Build a Phase-2 readiness check accessible at `/admin/help/phase-2-readiness` (platform_super_admin only):
- **Customer bug flow tested with a real authenticated test customer:** verify by examining `bug_submissions` for at least one row with `source_type='customer'` from a test customer.
- **Abuse monitoring dimension active and enforcing for non-platform tenants:** verify by examining `tenant_usage_metrics` for any non-PLATFORM_TENANT_ID tenant with `help_submission_count > 0`.
- Each check renders pass/fail with explanatory text. Operator uses this page to gate Phase 2 launch.
1. **Tests.**
- **Bug-intent recognizer:** customer message containing “this is broken” → travel concierge offers bug-report. Message without trigger → normal response.
- **Feature flag gate:** `PHASE_2_CUSTOMER_BUG_FLOW_ENABLED=false` → intent recognizer suppressed; no offer made even on matching phrase.
- **OAuth gate happy path:** authenticated customer accepts bug offer → flow handoff proceeds with conversation context preserved.
- **OAuth gate decline path:** anonymous customer declines sign-in → travel concierge offers tenant-side escalation; no GitHub issue created.
- **Anonymous-to-authenticated transfer:** anonymous user accepts bug offer, signs in mid-flow → conversation context migrates to authenticated user; bug flow continues seamlessly.
- **Per-customer rate limit:** 5 successful submissions in a day → 6th attempt produces the polite refusal; no `bug_submissions` row created on the 6th.
- **Quarantine doesn’t count against rate limit:** a submission that hits zero-tolerance quarantine doesn’t increment the per-customer counter.
- **`help_submission_rate` thresholds:** 20 submissions for a tenant in a day → state advances to `soft1`; admin in-app banner appears.
- **`help_submission_rate` daily reset:** at 00:05 UTC the counter and state reset to `ok`; new submissions advance state from `ok` again.
- **`help_submission_rate` soft2 throttle:** at 50 submissions in a day, the 51st through 60th within 10 minutes of each other produce the throttle refusal.
- **`help_submission_rate` hard:** at 100 submissions, the 101st returns the “paused until tomorrow” banner; no `bug_submissions` row created.
- **Issue-closure recording:** GitHub issue closed via webhook → `bug_submissions.github_issue_state='closed'` and `closed_at` are set; no in-app or email notification is sent to the customer.
- **Screenshot vision-PII warn-only:** an uploaded image with a face → warning banner shown; user can continue.
- **Cross-tenant probe:** test the new admin routes against the Part 7 Prompt 30 cross-tenant route probe — confirm none leak across tenants.
1. **Add to MEMORY.md at end of run:**
- The `help_submission_rate` dimension uses **per-day** semantics, NOT per-billing-period like the other five Part 6 Prompt 27 dimensions. The daily reset cron runs at 00:05 UTC.
- `PHASE_2_CUSTOMER_BUG_FLOW_ENABLED` defaults to `false` for ship-dark; operator flips to `true` per the §32.15 Phase 2 alignment.
- Per-customer rate limit: 5 submissions per day; quarantined submissions do NOT count.
- Screenshot vision-PII detection is warn-only at Phase 2 launch; operator flips `platform_settings.screenshot_pii_block_mode` to TRUE after 90-day data review.
- Issue closure: a GitHub `issues.closed` webhook records `closed_at` / `resolution_summary` on `bug_submissions`; customers are NOT notified on closure (§32.10.7).
- The §32.16 calls worth flagging from the spec — list each here so future engineers don’t re-discover:
  - GitHub as the issue system locks the integration; swap is contained in `apps/main/src/lib/github/` but is a swap.
  - Customer-reported feature requests are not in v1.
  - Help docs as part of the release pipeline means a doc typo correction requires a release.
  - help_doc_versions cache invalidates on every release; acceptable while deploys are infrequent.
- Interactive bug triage (§32.9) is built in Build Prompt 31 and runs in Phase 1; its own calls worth flagging — operator-dependent cadence, UI-driven reproduction only, operator discipline — are in spec §32.9.7.

**Definition of done:**

- Travel concierge bug-intent recognizer fires on the trigger phrases (gated by feature flag).
- OAuth gate handles authenticated and anonymous paths correctly; anonymous-to-authenticated transfer preserves context.
- Customer bug flow runs with adapted question wording; submits via the same GitHub issue creation path as tenant-side.
- Per-customer rate limit (5/day) enforced; polite refusal on excess.
- `help_submission_rate` abuse dimension is wired into Part 6 Prompt 27 framework with daily-reset semantics.
- Soft1 admin banner / Soft2 throttle / Hard pause all enforce correctly.
- The issue-closure webhook records closure on `bug_submissions`; no customer notification is sent.
- Phase 2 readiness check page reflects the §32.15.3 done criteria.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:migrations` all pass.

**After completion:** MEMORY.md entry per Task 14.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

## End of Part 9 build prompts

**After Build Prompts 31 and 32 complete, you have:**

- **Phase 1 self-service help (Prompt 31).** Tenant admins access `/admin/help` with a doc viewer (Markdown source → HTML / PDF / Word), search across docs, and three buttons opening a Help AI panel. The Help AI runs under the supervisor (kill switch, hallucination check, audit) with help docs indexed at `global` scope under a `help_ai` retrieval-audience tag — §6.9’s two-level scope model unchanged. Three flows: help / bug / feature, each with structured gathering and confidence/clarity scoring. Bug and feature submissions route to GitHub via the GitHub App authentication path with PII redaction running before the issue is created (zero-tolerance quarantine for SSN/CC/passport; tolerable PII redacted to `[REDACTED-*]` markers). Tenant IDs hashed in visible issue body. Resilience: GitHub failures retry up to 24 hours. Platform admin triage queues across tenants.
- **Phase 2 self-service help (Prompt 32).** Customer bug flow via the travel concierge with bug-intent recognizer, OAuth authentication gate, conversation handoff, and the same PII/GitHub path as Phase 1. Per-customer rate limit (5/day). `help_submission_rate` abuse dimension with per-day semantics (the one Part 6 §27 dimension that resets daily, not per billing period). A slim GitHub `issues.closed` webhook records closure on `bug_submissions`; customers are not notified. Bugs are triaged and fixed by an operator running Claude Code interactively (§32.9, built in Prompt 31) — there is no automated auto-fix pipeline.

**Across Parts 1–7 and 9, the platform has been specified for build from foundation through self-service help.** Build Prompt 33 (addendum — external data sources and media assets) follows in `build-prompts-33.md`:

- **Parts 1–2 (Prompts 01–07):** monorepo + infrastructure foundation; main schema; RAG schema with the strict two-level scope; persona registry.
- **Part 3 (Prompts 08–14):** RAG service inter-service auth; RAG ingest/approve; persona system + AI toggles; supervisor + kill switch; customer memory; CRM; host adapter framework.
- **Part 4 (Prompts 15–19):** money path (commissions, splits, Stripe payouts with deterministic idempotency, reconciliation); onboarding + admin review + subscription management; termination with chunk-license-survival + versioned consent + CCPA; white-label with custom domains; OAuth signup + group bookings with HMAC tokens.
- **Part 5 (Prompts 20–24):** forum chat with fail-closed Haiku moderation; RAG consumer side with 8-layer hallucination defense; RAG ingestion pipeline with PII zero-tolerance; email infrastructure + pre-cruise series; chat UI with hate-speech deny-list and 3-tier customer rate limit.
- **Part 6 (Prompts 25–28):** CCPA retention closeout with §25.4a three-category anonymization; four-layer auth + service-role discipline + forensics_log; five-dimension abuse monitoring with revenue-bound AI cost limits and the unique RAG promotion-bonus model.
- **Part 7 (Prompts 29–30):** environment variable Zod validation + secret rotation runbook; testing infrastructure with RLS snapshot diff, cross-tenant probes, AI behavior eval harness with Claude-as-judge.
- **Part 9 (Prompts 31–32):** self-service help with documentation, three Help AI flows, GitHub issue integration with PII redaction, customer bug flow, interactive bug triage, `help_submission_rate` abuse dimension.

**Parts 1–9: 32 build prompts across 16 files; 22 Opus, 10 Sonnet** — Opus concentrated where wrong-by-default is expensive (money, security, multi-tenancy, AI safety, compliance, PII). Build Prompt 33 (addendum) follows separately in `build-prompts-33.md`.

**Items deferred past v6.2 and noted across MEMORY:**

- The actual help documentation content (10+ doc sections — operator content task).
- AI behavior eval starter snapshots beyond the 3–5 per persona (operator + domain expert content task).
- Customer-direct feature requests (§32.12.2 deliberate v1 deferral).
- Non-UI reproduction types for interactive bug triage — background-job and API-contract bugs (v1 supports UI-driven Playwright reproduction only; see §32.9.7).
- The §29 Deployment & Infrastructure setup material (operator handles via separate CI/CD spec which is already built).
- Operator/legal-counsel content placeholders throughout: legal-page attribution wording, chunk-license-survival ICA wording, breach notification email wording, host-agency legal name, USPS validator choice, PDF renderer choice (Puppeteer vs react-pdf, decided by operator before Prompt 21), image generation provider (Replicate vs OpenAI, decided before Prompt 19), hate-speech deny-list seed content, port content for 17 NA cruise ports, slug deny-list quarterly review schedule.

The platform after Part 9 has the complete v6.2 surface from foundation through customer/tenant self-service. Operations begin once the operator-side content + decisions land and the §32.15 phased rollout completes.