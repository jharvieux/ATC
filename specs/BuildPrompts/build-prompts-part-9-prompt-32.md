# Build Prompts — Spec v6.2, Part 9 (continued)

**This file contains Build Prompt 32 only.** Prompt 31 was in the prior file. This is the last build prompt in the v6.2 series.

-----

# BUILD PROMPT 32 — Phase 2: customer bug flow, auto-fix pipeline with two-gate repro, help-submission abuse dimension

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** The §32.9.2 two-gate reproduction contract is the defense against the “auto-fixed but didn’t actually fix anything” loop. The pre-fix gate MUST fail (proving the script demonstrates the bug); the post-fix gate MUST pass (proving the fix removes the demonstrated behavior). A wrong implementation either rubber-stamps non-fixes (faulty script passes against buggy code; “fix” changes nothing; PR ships green) or constantly produces fix-ineffective false positives (engineers stop trusting the gate, then disable it). The two-gate logic must distinguish between “the script is faulty” and “the bug is already fixed in main” and “the fix didn’t work” — three failure modes that need different recovery paths. The §32.10 customer bug flow lands in the same redaction pipeline as Phase 1 with the same compliance stakes, but now the PII surface includes the customer’s own messages from the entire travel-concierge conversation (the handoff preserves context — anything the customer said about themselves before requesting a bug report is in scope). The §32.11 abuse-monitoring `help_submission_rate` dimension extends Part 6 Prompt 27’s five-dimension framework with the same monotonic-state-within-billing-period semantics plus a per-customer rate limit that is independent of the tenant-level dimension. Each piece is the kind of correctness work that, when wrong, produces silent failure modes.

**Spec references:** Part 9 §32.9 (bug auto-fix pipeline — overview, workflow with two-gate, PR conventions, manual override, failure modes, cost controls), §32.10 (customer bug flow — trigger detection, authentication gate, flow handoff, issue creation, customer confirmation, confidence threshold, resolution notification), §32.11 (abuse monitoring — new dimension, initial thresholds, cost attribution, per-customer rate limit), §32.13.2 (screenshot vision-PII — warn vs block phase decision), §32.14 (env vars — Phase 2 additions), §32.15.3 (Phase 2 done definition), §32.16 (calls worth flagging). Depends on Part 5 Prompt 24 (customer travel-concierge persona — extended here with bug intent recognizer), Part 5 Prompt 22 (PII redaction pipeline), Part 6 Prompt 27 (abuse-monitoring framework — five dimensions; this prompt adds the sixth), Build Prompt 31 (Help AI persona + bug flow + GitHub issue creation — reused here for customer-side flow).

**Prerequisite check:** Build Prompts 01–31 are committed. The Phase 1 Help AI flows are live for tenant admins. A separate `CLAUDE_CODE_API_KEY` is provisioned with its own Anthropic Console spending limit per §32.9.6.

**Goal:** Build the Phase 2 additions: env vars, customer bug flow triggered by the travel concierge intent recognizer with OAuth gate and chat-surface handoff, the bug auto-fix pipeline (GitHub Actions workflow + repro-script generation + two-gate contract + draft PR + cost controls), the abuse-monitoring `help_submission_rate` dimension with per-customer rate limit, the resolution notification flow on GitHub issue close, and the Phase 2 feature flag that gates customer-side until launch.

**Tasks:**

1. **Env vars — extend the Zod schema.** Add to `apps/main/src/lib/env-check.ts`:
   
   ```
   BUG_AUTOFIX_DAILY_PLATFORM_CAP (required, default 10)
   BUG_AUTOFIX_DAILY_TENANT_CAP (required, default 3)
   CLAUDE_CODE_API_KEY (required, secret) — z.string().startsWith('sk-ant-')
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
- **Inngest event registry entries:** `help.customer_bug_triggered`, `help.customer_bug_completed`, `help.autofix_triggered`, `help.autofix_repro_pre_passed_failure`, `help.autofix_repro_post_failed_failure`, `help.autofix_pr_opened`. All `tenant_scoped` except `help.autofix_*` which are `platform_admin`.
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
- Labels applied: `bug` + `customer-reported` (not `tenant-admin-reported`). If confidence_score ≥ threshold: also `auto-fix-candidate`.
1. **Issue body adjustments for customer-reported — §32.10.4.** Update the issue body builder in `apps/main/src/lib/github/issues.ts`:
- `submitter_user_id` (customer’s `user_id`) is NEVER exposed in the public issue body — only stored in `bug_submissions`.
- The `tenant_slug` (already hashed in the visible portion via the Part 6 Prompt 25 PLATFORM_PEPPER hashing from Prompt 31 Task 10) appears so engineering can identify the affected tenant.
- Source line in the body: `Source: customer-reported, tenant {tenant_id_hash}`.
- The customer’s raw text (post-PII-redaction) appears verbatim per §32.10.4.
1. **Customer confirmation UI — §32.10.5.** After the GitHub issue is created (or queued for retry):
- The travel concierge responds: “Thanks — I’ve sent that to the engineering team. You’ll hear back if we need more info.”
- The customer does NOT see the GitHub issue URL. They see a friendly reference ID computed from `bug_submissions.id` (e.g., `BR-` followed by 8 base32 chars derived from the UUID).
- The `[Yes, file a bug]` mode banner clears; the travel concierge returns to normal mode.
1. **Resolution notification — §32.10.7.** When a corresponding GitHub issue is closed (the `closeIssue` from Prompt 31 OR a webhook from GitHub):
- Build Inngest function `bug-resolution-notify` listening for GitHub `issues.closed` events via the GitHub App webhook.
- Webhook handler: `POST /api/webhooks/github` validates the signature (GitHub App webhook secret), parses the issue event, looks up `bug_submissions WHERE github_issue_number = event.issue.number`.
- If matched AND the customer has opted into resolution notifications (per Part 6 Prompt 25 `users.marketing_email_opt_in` is too broad — use a more specific `users.bug_resolution_notify_opt_in BOOLEAN NOT NULL DEFAULT TRUE` added in this prompt’s migration):
  - **In-app notification** via the Part 5 Prompt 23 `notifications` table.
  - **Email** via the Part 4 Prompt 18 BrandedLayout template — extends the existing email path.
  - Phrasing per §32.10.7: “The issue you reported has been resolved. Thanks for letting us know.” No technical detail. No GitHub link.
- Write `bug_submissions.closed_at = NOW()` and `resolution_summary` (truncated from the GitHub issue’s closing comment if present, otherwise blank).
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
1. **Bug auto-fix pipeline — GitHub Actions workflow — §32.9.** Create `.github/workflows/bug-auto-fix.yml`:
- **Trigger:** `issues` event with action `labeled`, where labels include `bug` AND `auto-fix-candidate`.
- **Job 1: Parse issue body.** Extract structured fields using a parser keyed on the section headers (`### Where in the platform`, `### Actual behavior`, etc.) defined in Build Prompt 31’s issue body format.
- **Job 2: Spin up staging environment.** Per CI/CD §5 (already built per operator), the existing staging-refresh flow runs to ensure a fresh DB copy. Adapt: the auto-fix workflow does NOT need a full staging refresh — it uses the existing staging instance with its current state.
- **Job 3: Generate Playwright reproduction script.** Call Claude Code API (`CLAUDE_CODE_API_KEY`, separate key with separate spending limit per §32.9.6):
  - Provide the parsed issue fields and ask Claude Code to produce a Playwright script that reproduces the reported behavior.
  - Generated script lives at `.github/auto-fix-artifacts/repro-{issue_number}.spec.ts` (artifact, not committed).
  - If Claude Code cannot produce a valid script (parse error in output, missing imports, etc.): add label `repro-failed`; post a comment on the issue summarizing what was tried; abort. Does NOT count against the daily cap because the abort happened pre-gate.
- **Job 4: Pre-fix repro gate.** Run the generated Playwright script against the CURRENT staging code (no fix applied).
  - **The script MUST FAIL.** If the script passes against pre-fix code: the bug doesn’t reproduce OR the script is faulty. Either way:
    - Add label `repro-script-faulty`.
    - Post a comment: “Auto-fix attempted but the generated reproduction script passed against current code. The bug may already be fixed, or the script is not correctly demonstrating the bug. Marking for human review.”
    - Remove `auto-fix-candidate` label; add `pending-human-review`.
    - Abort.
  - If the script fails (as expected — demonstrating the bug): add label `repro-confirmed`.
- **Job 5: Generate fix.** With pre-fix gate passed, call Claude Code API again asking for a fix:
  - Provide: the parsed issue, the repro script, the relevant source files (Claude Code identifies which files to read).
  - Claude Code produces a patch.
  - Apply the patch to a fresh branch `auto-fix/issue-{issue_number}`.
- **Job 6: Post-fix repro gate.** Run the SAME Playwright script against the patched code.
  - **The script MUST PASS.** If the script still fails against the patched code: the fix didn’t work.
    - Add label `fix-ineffective`.
    - Post a comment: “Auto-fix attempted a patch but the reproduction script still fails. The fix did not address the bug. Marking for human review.”
    - Remove `auto-fix-candidate` label; add `pending-human-review`.
    - Abort (no PR opened).
  - If the script passes: proceed to PR creation.
- **Job 7: Open draft PR — §32.9.3.** Open a draft PR `auto-fix/issue-{N}` → `dev`:
  - Title: `fix: {first 80 chars of issue title} (#{issue_number})`.
  - Body includes: link to issue, summary of analysis, proposed fix description, note that production deploy still requires human approval.
  - Labels: `auto-fix-pr`.
  - Includes BOTH the fix AND the repro script (so post-merge tests will continue to catch this regression).
  - The PR is in DRAFT state — not ‘ready for review’. Human reviewer marks ready when satisfied.
- **Documentation:** ship `docs/runbooks/bug-auto-fix.md` describing the workflow, the gates, common failure modes, and operator-actionable steps when the workflow needs intervention.
1. **Two-gate contract correctness — §32.9.2a calls worth flagging.** Document in MEMORY and in the runbook:
- The pre-fix gate runs against CURRENT staging code, not a fresh checkout. If the bug was already fixed by an earlier release, the gate correctly catches that with the `repro-script-faulty` label and notes “bug may be already fixed.”
- The post-fix gate runs against the proposed fix applied locally to the workflow runner. Once the gate passes and the PR opens, normal CI runs against the full PR diff and may catch other regressions.
- **Both gates use the SAME Playwright script.** A fix that requires changing the test is suspicious. The workflow MUST NOT regenerate the script between pre-fix and post-fix runs. If the script needs to change, that’s a signal that either the script was wrong or the fix changed observable behavior — either way, human review.
1. **Cost controls — §32.9.6.** Three caps:
- **`BUG_AUTOFIX_DAILY_PLATFORM_CAP`** (default 10): the workflow checks against this before running. The check queries `audit_log WHERE action = 'help.autofix_triggered' AND created_at >= CURRENT_DATE`. If count ≥ cap: skip; add label `autofix-cap-reached`; defer to next day.
- **`BUG_AUTOFIX_DAILY_TENANT_CAP`** (default 3): same query but `tenant_id = $tenant_id`. If reached, defer.
- **Anthropic Console spending limit:** `CLAUDE_CODE_API_KEY` is a SEPARATE key with its own spending limit set in the Anthropic dashboard. This is operator config, not code; document in MEMORY.
- All Claude Code calls write to `ai_call_log` (Part 6 Prompt 27 instrumented wrapper) with `tenant_id = PLATFORM_TENANT_ID` (the synthetic platform-internal tenant from Part 6 Prompt 27 ambiguous-attribution rule), `purpose = 'help_ai_main'` (reusing the enum) — or add a new enum value `'autofix_claude_code'` per Prompt 27 task 11 extension; document choice in MEMORY.
1. **Failure mode handling per §32.9.5.** Each failure mode produces specific labels and comments:
- Staging DB copy fails (rare — the workflow doesn’t refresh DB, but if the staging environment is broken): label `repro-failed` with explanation; alert platform admin.
- Playwright script invalid: comment on issue; label `repro-failed`.
- Claude Code fix attempt times out: close any partial PR; comment; `repro-confirmed` remains; needs human.
- Fix PR fails CI: PR remains draft; engineer takes over.
- Fix PR review rejected: engineer closes PR; issue stays open.
- **All failure modes write `audit_log` rows** with `action = 'help.autofix_{outcome}'`.
1. **Manual override — §32.9.4.** Platform admin route `POST /api/admin/help/issues/:issue_number/needs-human-fix`:
- Wrapped in `withPlatformAdminAudit` with `reason = 'autofix_manual_override'`.
- Calls GitHub API to remove `auto-fix-candidate` label and add `needs-human-fix`.
- The workflow trigger filters on `auto-fix-candidate` so removing it prevents further auto-fix attempts.
- Useful when admin knows the bug is sensitive (security, compliance, customer-impact heavy) or when a previous auto-fix attempt produced a poor result.
1. **Screenshot vision-PII — §32.13.2 phase-aware behavior.** Build `apps/main/src/lib/help-ai/screenshot-pii-detector.ts`:
- On screenshot upload during a bug flow: run a Haiku vision call asking “Does this image contain personally-identifying information (faces, license plates, ID documents, financial data, screen content with PII)? Return JSON `{ detected: boolean, categories: string[] }`.”
- **Phase 2 behavior: warn-only.** If detected: show the user a warning banner: “This image may contain personal information. Are you sure you want to attach it?” with `[Continue] [Replace]` buttons. Continue → attach as normal.
- **Phase 3 behavior** (operator flips a flag `platform_settings.screenshot_pii_block_mode = TRUE` after 90 days of data evaluation): refuse upload and ask the user to redact and re-upload. This is operator-controllable without a code deploy.
- Either way: EXIF metadata is stripped on upload (already done in Build Prompt 31 Task 10 step 2).
1. **Phase 2 done definition checks — §32.15.3.** Build a Phase-2 readiness check accessible at `/admin/help/phase-2-readiness` (platform_super_admin only):
- **Customer bug flow tested with a real authenticated test customer:** verify by examining `bug_submissions` for at least one row with `source_type='customer'` from a test customer.
- **Auto-fix workflow successfully reproduces a synthetic bug on staging:** verify by examining `audit_log` for at least one `help.autofix_repro_confirmed` event.
- **Auto-fix workflow opens a draft PR with proposed fix; engineer review confirms the fix is reasonable:** verify by examining GitHub for at least one merged PR with the `auto-fix-pr` label (read-only check via the GitHub API).
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
- **Auto-fix workflow happy path:** a synthetic bug labeled `auto-fix-candidate` with confidence ≥ 0.7:
  - Triggers the workflow.
  - Generates a repro script.
  - Pre-fix gate fails (good — bug demonstrated).
  - Fix generated and applied.
  - Post-fix gate passes.
  - Draft PR opened with the repro included.
- **Auto-fix workflow `repro-script-faulty`:** a synthetic bug whose generated script passes against pre-fix code → workflow aborts; `repro-script-faulty` label applied; PR NOT created.
- **Auto-fix workflow `fix-ineffective`:** a synthetic bug whose repro passes pre-fix but the fix doesn’t change behavior → post-fix gate fails; `fix-ineffective` label applied; PR NOT created.
- **Daily caps:** at platform cap reached, subsequent eligible issues are labeled `autofix-cap-reached` and deferred.
- **Per-tenant cap:** 3 successful auto-fixes for one tenant in a day → the 4th is deferred.
- **Manual override:** admin applies `needs-human-fix` → workflow does NOT trigger on subsequent events.
- **Resolution notification:** GitHub issue closed via webhook → `bug_resolution_notify` Inngest fires; in-app notification + email sent to opted-in customer.
- **Screenshot vision-PII warn-only:** an uploaded image with a face → warning banner shown; user can continue.
- **Cross-tenant probe:** test the new admin routes against the Part 7 Prompt 30 cross-tenant route probe — confirm none leak across tenants.
1. **Add to MEMORY.md at end of run:**
- The `help_submission_rate` dimension uses **per-day** semantics, NOT per-billing-period like the other five Part 6 Prompt 27 dimensions. The daily reset cron runs at 00:05 UTC.
- `PHASE_2_CUSTOMER_BUG_FLOW_ENABLED` defaults to `false` for ship-dark; operator flips to `true` per the §32.15 Phase 2 alignment.
- The Claude Code auto-fix uses a SEPARATE Anthropic API key (`CLAUDE_CODE_API_KEY`) with its own spending limit in the Anthropic Console. This is operator config.
- Auto-fix `purpose` enum: chose either reusing `'help_ai_main'` or adding a new `'autofix_claude_code'` value — document the choice.
- The two-gate repro contract: pre-fix MUST fail, post-fix MUST pass, SAME script for both. Test changing between gates is forbidden by the workflow.
- Per-customer rate limit: 5 submissions per day; quarantined submissions do NOT count.
- Screenshot vision-PII detection is warn-only at Phase 2 launch; operator flips `platform_settings.screenshot_pii_block_mode` to TRUE after 90-day data review.
- Resolution notification: `users.bug_resolution_notify_opt_in` defaults TRUE; customers can opt out via `/settings/privacy`.
- The §32.16 calls worth flagging from the spec — list each here so future engineers don’t re-discover:
  - GitHub as the issue system locks the integration; swap is contained in `apps/main/src/lib/github/` but is a swap.
  - Uniform confidence threshold for customer vs tenant-admin bugs may need per-source split in Phase 3.
  - Auto-fix Playwright reproduction is UI-driven only at v1; background-job and API-contract bugs need additional repro types.
  - Customer-reported feature requests are not in v1.
  - Help docs as part of the release pipeline means a doc typo correction requires a release.
  - help_doc_versions cache invalidates on every release; acceptable while deploys are infrequent.
  - No SLA on auto-fix turnaround.

**Definition of done:**

- Travel concierge bug-intent recognizer fires on the trigger phrases (gated by feature flag).
- OAuth gate handles authenticated and anonymous paths correctly; anonymous-to-authenticated transfer preserves context.
- Customer bug flow runs with adapted question wording; submits via the same GitHub issue creation path as tenant-side.
- Per-customer rate limit (5/day) enforced; polite refusal on excess.
- `help_submission_rate` abuse dimension is wired into Part 6 Prompt 27 framework with daily-reset semantics.
- Soft1 admin banner / Soft2 throttle / Hard pause all enforce correctly.
- Auto-fix GitHub Actions workflow triggers on `auto-fix-candidate` issues; two-gate contract correctly distinguishes happy path / `repro-script-faulty` / `fix-ineffective`.
- Daily platform cap and per-tenant cap enforced.
- Manual override (`needs-human-fix`) prevents auto-fix.
- Resolution notification fires on GitHub issue close.
- Phase 2 readiness check page reflects the four §32.15.3 done criteria.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:migrations` all pass.

**After completion:** MEMORY.md entry per Task 19.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

## End of Part 9 build prompts — and end of the v6.2 build-prompts series

**After Build Prompts 31 and 32 complete, you have:**

- **Phase 1 self-service help (Prompt 31).** Tenant admins access `/admin/help` with a doc viewer (Markdown source → HTML / PDF / Word), search across docs, and three buttons opening a Help AI panel. The Help AI runs under the supervisor (kill switch, hallucination check, audit) with a dedicated `platform-docs` RAG scope — the single deviation from §6.9’s two-level scope model. Three flows: help / bug / feature, each with structured gathering and confidence/clarity scoring. Bug and feature submissions route to GitHub via the GitHub App authentication path with PII redaction running before the issue is created (zero-tolerance quarantine for SSN/CC/passport; tolerable PII redacted to `[REDACTED-*]` markers). Tenant IDs hashed in visible issue body. Resilience: GitHub failures retry up to 24 hours. Platform admin triage queues across tenants.
- **Phase 2 self-service help (Prompt 32).** Customer bug flow via the travel concierge with bug-intent recognizer, OAuth authentication gate, conversation handoff, and the same PII/GitHub path as Phase 1. Per-customer rate limit (5/day). `help_submission_rate` abuse dimension with per-day semantics (the one Part 6 §27 dimension that resets daily, not per billing period). Auto-fix pipeline with the two-gate reproduction contract (pre-fix MUST fail, post-fix MUST pass, SAME script for both — defense against “auto-fixed but didn’t actually fix anything”). Cost controls: daily platform cap (10), per-tenant cap (3), separate Anthropic API key with its own spending limit. Resolution notifications on GitHub issue close.

**v6.2 build-prompts series complete.** Across Parts 1–7 and 9, the platform has been specified for build from foundation through self-service help:

- **Parts 1–2 (Prompts 01–07):** monorepo + infrastructure foundation; main schema; RAG schema with the strict two-level scope; persona registry.
- **Part 3 (Prompts 08–14):** RAG service inter-service auth; RAG ingest/approve; persona system + AI toggles; supervisor + kill switch; customer memory; CRM; host adapter framework.
- **Part 4 (Prompts 15–19):** money path (commissions, splits, Stripe payouts with deterministic idempotency, reconciliation); onboarding + admin review + subscription management; termination with chunk-license-survival + versioned consent + CCPA; white-label with custom domains; OAuth signup + group bookings with HMAC tokens.
- **Part 5 (Prompts 20–24):** forum chat with fail-closed Haiku moderation; RAG consumer side with 8-layer hallucination defense; RAG ingestion pipeline with PII zero-tolerance; email infrastructure + pre-cruise series; chat UI with hate-speech deny-list and 3-tier customer rate limit.
- **Part 6 (Prompts 25–28):** CCPA retention closeout with §25.4a three-category anonymization; four-layer auth + service-role discipline + forensics_log; five-dimension abuse monitoring with revenue-bound AI cost limits and the unique RAG promotion-bonus model.
- **Part 7 (Prompts 29–30):** environment variable Zod validation + secret rotation runbook; testing infrastructure with RLS snapshot diff, cross-tenant probes, AI behavior eval harness with Claude-as-judge.
- **Part 9 (Prompts 31–32):** self-service help with documentation, three Help AI flows, GitHub issue integration with PII redaction, customer bug flow, auto-fix pipeline with two-gate reproduction contract, `help_submission_rate` abuse dimension.

**32 build prompts across 16 files. 22 Opus, 10 Sonnet** — Opus concentrated where wrong-by-default is expensive (money, security, multi-tenancy, AI safety, compliance, PII).

**Items deferred past v6.2 and noted across MEMORY:**

- The actual help documentation content (10+ doc sections — operator content task).
- AI behavior eval starter snapshots beyond the 3–5 per persona (operator + domain expert content task).
- Customer-direct feature requests (§32.12.2 deliberate v1 deferral).
- Background-job and API-contract auto-fix repro types (v1 supports UI-driven Playwright only).
- The §29 Deployment & Infrastructure setup material (operator handles via separate CI/CD spec which is already built).
- Operator/legal-counsel content placeholders throughout: legal-page attribution wording, chunk-license-survival ICA wording, breach notification email wording, host-agency legal name, USPS validator choice, PDF renderer choice (Puppeteer vs react-pdf, decided by operator before Prompt 21), image generation provider (Replicate vs OpenAI, decided before Prompt 19), hate-speech deny-list seed content, port content for 17 NA cruise ports, slug deny-list quarterly review schedule.

The platform after Part 9 has the complete v6.2 surface from foundation through customer/tenant self-service. Operations begin once the operator-side content + decisions land and the §32.15 phased rollout completes.