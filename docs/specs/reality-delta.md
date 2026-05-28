# Tech-spec ⇄ reality delta

Source-of-truth notes for keeping the v6 tech spec (`specs/TechSpec/section-*.html`) and the §33–§40 addenda accurate to what actually shipped. Every implementation-level deviation from the spec is recorded here so a future spec-update pass can apply them without re-discovery.

---

## How to use this file

This file is for **Claude (or a human) doing a tech-spec sync pass.** It is the inverse of the spec: the spec is "what should be," this file is "what is, and why it differs."

- **For each entry below**, the spec needs an edit to match. The `Action for spec update` line tells you exactly what to change.
- **For deferred items**, the spec should NOT be edited to remove the original text — instead add a Status callout (e.g. `> **Status (2026-05-25):** Deferred. See `docs/specs/reality-delta.md#…` and MEMORY D-NNN.`).
- **For runtime decisions**, the spec should be updated to match reality unless there's a documented reason it's still aspirational.
- **For security changes**, the spec needs new prose reflecting the threat model and the actual control.

Each entry references **MEMORY D-NNN** (the canonical decision record) and the **PR number** where the change landed. Cross-check both when updating the spec.

If a delta you see in code is NOT in this file, add it as you go. This file is append-only the same way `MEMORY.md` is — never edit prior entries without explicit permission.

---

## Table of contents

1. [Deferred for cost reasons](#1-deferred-for-cost-reasons)
2. [Deferred for scope / future build prompts](#2-deferred-for-scope--future-build-prompts)
3. [Deferred for legal / operator content](#3-deferred-for-legal--operator-content)
4. [Runtime decisions (not in spec)](#4-runtime-decisions-not-in-spec)
5. [Security changes from audits](#5-security-changes-from-audits)
6. [Schema / migration deviations](#6-schema--migration-deviations)
7. [API contract deviations](#7-api-contract-deviations)
8. [Spec inaccuracies clarified by implementation](#8-spec-inaccuracies-clarified-by-implementation)
9. [Open spec gaps still to be wired](#9-open-spec-gaps-still-to-be-wired)

---

## 1. Deferred for cost reasons

Items the spec described as in-scope that we deliberately stubbed because they cost real money per invocation. Each has an estimated marginal cost and an "operator opt-in" path that doesn't require a code change to enable.

### §32.13.2 — Help screenshot vision-PII detector
- **Spec said:** Help-AI screenshot uploads scanned for faces, license plates, ID documents, financial data, PII via a Haiku vision call. UI blocks upload (Phase 3) if PII detected.
- **Reality:** `apps/main/src/lib/help-ai/screenshot-pii-detector.ts` returns `{ detected: false }` regardless of input. The CONTRACT shape is stable; flipping to real detection is a swap of the function body to call `instrumentedClaudeCall` with the image attached.
- **Estimated cost when enabled:** ~$0.003 per uploaded screenshot (Haiku vision pricing as of 2026-05). At 10K help submissions/month with one screenshot each → ~$30/month at platform scale.
- **Source:** MEMORY D-068 (BP32 cost decision).
- **Action for spec update:** §32.13.2 needs a `> **Status (2026-05-23):** Deferred per cost (D-068). Stub returns false. Operator flips `platform_settings.screenshot_pii_block_mode` once enabled.` callout.

### §32.6.5 — Help-AI confidence scoring
- **Spec said:** Six-factor confidence scoring (specificity_of_location, clarity_of_actual_behavior, …) drives the show-summary-or-keep-gathering decision in the bug/feature flow.
- **Reality:** `apps/main/src/lib/help-ai/confidence-scorer.ts` returns uniform 0.5 for every factor + an overall score of 0.5, marked `stubbed: true`. The bug/feature flow proceeds based on completed-questions heuristic instead.
- **Estimated cost when enabled:** ~$0.0015 per bug/feature submission (one Haiku call). At 1K submissions/month → ~$1.50/month — trivial.
- **Why deferred despite low cost:** BP31 Phase B chose to ship the end-to-end flow first, then layer scoring once real bug submissions exist to calibrate the prompt. Calibration was the bottleneck, not cost.
- **Source:** MEMORY D-066 (BP31 Phase B), file docstring.
- **Action for spec update:** §32.6.5 needs `> **Status (2026-05-23):** Scoring stub returns uniform 0.5; replace once 100+ real submissions exist to calibrate Haiku prompt (D-066).`

### §22.4 — Tolerable-PII Haiku redaction
- **Spec said:** Two-stage PII redaction. Stage 1 is zero-tolerance regex (SSN, credit card → quarantine). Stage 2 is Haiku-driven "tolerable" redaction of context-dependent PII (names in casual contexts, etc).
- **Reality:** `apps/main/src/lib/help-ai/pii-redaction.ts` `redactTolerablePii()` is a sync pass-through that returns the input unchanged. Zero-tolerance prefilter works; tolerable layer is `TODO(haiku-pii-redaction)`.
- **Estimated cost when enabled:** ~$0.001–0.003 per RAG ingest chunk depending on length. At 1K chunks/day → ~$1–3/day.
- **Source:** Code docstring; spec §22.4.
- **Action for spec update:** §22.4 needs to acknowledge two-stage design with the second stage deferred. Pattern matches §32.13.2 above.

### §24 — Tone Haiku
- **Spec said:** Tone match scoring uses Haiku to detect tonal drift mid-conversation.
- **Reality:** `TODO(tone-haiku)` placeholder; tone is currently derived from heuristic match against persona's `tone_level` integer (1–5).
- **Estimated cost when enabled:** Haiku call per message in supervisor sampling (1%). At 100K messages/month → ~$1.50/month.
- **Source:** `apps/main/src/lib/personas/build-system-prompt.ts:39` TODO.
- **Action for spec update:** §24 should document the heuristic baseline + the Haiku upgrade path.

### §27.12 — AI vendor pricing auto-refresh
- **Spec said:** Daily Inngest cron scrapes Anthropic + OpenAI pricing pages and updates `platform_settings.ai_pricing_catalog`.
- **Reality:** Scrapers were never built (ToS-exposed + HTML-format-fragile). Operator manages via `PUT /api/admin/ai-pricing` instead. Cron flips `platform_settings.ai_pricing_stale = true` when last operator update > 30 days old, so the admin dashboard can nudge re-verification.
- **Estimated cost when "enabled":** $0 (operator does it manually). Real-cost decision is the risk of ToS-exposure if we DO build scrapers.
- **Source:** PR #191 (this session). Earlier: MEMORY D-072 family for vendor adapter posture.
- **Action for spec update:** §27.12 should describe the operator-managed flow with the staleness signal. Remove (or strike-through) the scraper text.

### §12 — AI Evaluation Harness
- **Spec said:** Full eval harness with golden-set regression detection, Claude-as-judge contested-verdict queue, drift trend alerts.
- **Reality:** Design-only deliverable. Skeleton + runbook shipped; no actual eval runs wired in CI. To be productionized after launch when there's real conversation data to evaluate.
- **Estimated cost when enabled:** Variable — depends on golden-set size × judge tokens × frequency. Initial estimate $20–50/run; running weekly → $100–250/month.
- **Source:** MEMORY D-024.
- **Action for spec update:** §12 needs a top-of-section status callout.

### §32.10 — Customer-chat / Help-AI auto-reply (Gmail inbound)
- **Spec said:** Inbound Gmail messages may trigger AI auto-reply (off by default, opt-in per tenant).
- **Reality:** Whole Gmail inbound OAuth flow is stubbed (see §3 below: operator hasn't provisioned the GCP project). The auto-reply layer is downstream of that.
- **Estimated cost when enabled:** Operator-decision; only meaningful once OAuth ships.
- **Source:** PR #192, MEMORY D-068.
- **Action for spec update:** Cross-reference §32.10 to the Gmail setup runbook.

---

## 2. Deferred for scope / future build prompts

Items that aren't blocked on cost but on sequencing — they're scheduled for a future BP and the current state is a deliberate placeholder.

### §20.2 — Platform-native fallback booking flow
- **Spec said:** Full 4-stage booking flow for tenants without a host adapter.
- **Reality:** Stub UI at `apps/main/src/app/booking/flow/[id]/[stage]/page.tsx` with `TODO(prompt-24)` markers. The booking ENGINE (host adapters, commission resolution, payouts) is fully built; the customer-facing flow is what's missing.
- **Source:** Code TODOs; tagged as `prompt-24` future BP.
- **Action for spec update:** §20.2 should mark the customer-flow UI as "scaffolded, full implementation in prompt-24."

### §9.6 — Persona tool-use registry
- **Spec said:** Tools registry with full schemas per tool (host_adapter, crm_lookup, quote_compute, booking_lookup, customer_memory).
- **Reality:** `apps/main/src/lib/personas/tools.ts` has stubs with `TODO(prompt-12/13/14)` markers. Tool DISPATCH works; schemas are placeholder shapes.
- **Source:** Code TODOs.
- **Action for spec update:** §9.6 should mark tool schemas as "real shapes finalized in prompts 12/13/14."

### §22.12 — Duplicate-action "replace" mode (CLOSED — now wired)
- **Spec said:** Three duplicate-resolution modes: replace, add_with_supersedes, cancel.
- **Reality (until 2026-05-25):** `replace` returned `501 not_yet_implemented`; reviewers had to use `add_with_supersedes`.
- **Reality (now):** Fully wired via new RAG-side `/api/admin/replace-chunk` endpoint.
- **Source:** PR #188.
- **Action for spec update:** No change needed; spec was already correct, this resolves the gap.

### §22.8 — RAG `/demote-chunk` endpoint (CLOSED — now wired)
- **Spec said:** Demote a globally-promoted chunk via `/demote/chunk/:id` with mode=to_tenant_scope|hard_delete.
- **Reality (until 2026-05-25):** Main-side recorded intent but RAG-side endpoint didn't exist; treated 404 as "not yet implemented."
- **Reality (now):** Wired with proper auth posture (platform-admin only, scope-aware).
- **Source:** PR #186.
- **Action for spec update:** No change needed.

### §27.4 — Cost-display surfaces in tenant settings (deferred)
- **Spec said:** `/settings/ai-mode` shows real-time cost range per mode based on tenant usage.
- **Reality:** Hardcoded `"varies based on usage"` strings; `TODO(§27.12-cost-display)` markers.
- **Source:** Code TODOs at `apps/main/src/app/(tenant)/settings/ai-mode/page.tsx`.
- **Action for spec update:** §27.4 / §27.12 cost-display sub-section should note "to be wired once tenant_usage_metrics aggregation lands."

### §17.4 — Legal documents from `legal_documents` table (deferred)
- **Spec said:** Onboarding legal-acceptance page loads document content from `legal_documents` table.
- **Reality:** `apps/main/src/app/(onboarding)/onboarding/legal/page.tsx` has placeholder text with `TODO(prompt-17)` markers. The `legal_documents` schema and `legal_consents` table exist, the publish flow works, but the onboarding-time render still uses inline placeholders.
- **Source:** Code TODOs.
- **Action for spec update:** Acknowledge prompt-17 staging.

### §15.14.6 — ICA chunk-license-survival clause text
- **Spec said:** Standard ICA contract with chunk-license-survival clause per §15.14.6.
- **Reality:** Placeholder text in `apps/main/src/app/(onboarding)/onboarding/ica/page.tsx` with `TODO(legal-attorney)` markers (see also §3 below).
- **Source:** Code TODOs.

### BP-tagged future deferrals
The following BPs are scheduled but not yet built. The current code has explicit `TODO(<bp-tag>)` markers where they'll wire in:
- `bp22-rag-replace` — handled by PR #188, marker can be deleted from any remaining sites
- `bp23-email` — pre-cruise emails, group invitations
- `bp27-abuse-signals` — consumer of `pii-quarantine-aggregator` writes
- `prompt-12/13/14` — persona tools registry
- `prompt-17` — legal docs render from DB
- `prompt-23` — groups email template
- `prompt-24` — booking flow chat embed + booking-flow UI

---

## 3. Deferred for legal / operator content

Things blocked on external humans (attorney, legal counsel, operator domain knowledge). Spec text is illustrative; final wording lives elsewhere.

### §16.7.1 — Always-on attribution wording
- **Spec said:** `/legal/*` pages render "Powered by AI Travel Concierge" attribution.
- **Reality:** `apps/main/src/components/branding/LegalPageAttribution.tsx` has illustrative text with `TODO(legal-attorney): final wording per §16.7.1`. Tier-floor logic is real.
- **Action for spec update:** Note that wording is attorney-finalized.

### §15.14.6 — ICA contract text
- **Spec said:** Standard ICA with chunk-license-survival.
- **Reality:** Placeholder + `TODO(legal-attorney)`. Two TODO sites in `onboarding/ica/page.tsx`.

### §25.9 — Breach notification templates
- **Spec said:** Customer + tenant-admin breach notification emails per CCPA / state-specific rules.
- **Reality:** Templates exist at `apps/main/src/emails/BreachNotification{User,TenantAdmin}.tsx` with `TODO(legal-counsel)` markers. Send dispatcher `lib/email/send-breach-notifications.ts` is wired (Knip flagged these as "unused files" — they ARE used by the §25.9 incident response path, just unwired currently).
- **Action for spec update:** Cross-reference §25.9 to the legal-counsel review queue.

### §25.5 — Sub-processors disclosure
- **Spec said:** Customer-facing sub-processors page enumerating Stripe, Anthropic, OpenAI, Supabase, Vercel, Resend, etc.
- **Reality:** `apps/main/src/app/legal/sub-processors/page.tsx` renders the list with `TODO(operator): bump after each annual review.` Annual review cadence not enforced.
- **Action for spec update:** §25.5 should reference the operator review cadence.

### §27.4.2 / .3 / .4 / .5 — Tier base counts (RESOLVED — now in DB)
- **Spec said:** Hardcoded tier base counts (chat 500/2000/5000/…, email 50/150/500/…, etc.) inline in the spec text.
- **Reality:** Moved to `tier_definitions` table (`chat_base_monthly`, `email_base_daily`, `group_invite_base_monthly`, `rag_base_chunks` columns) so operators can adjust per-tier without a deploy.
- **Source:** PR #189 (migration `20260625000004_tier_definitions_abuse_bases.sql`).
- **Action for spec update:** §27.4.2/.3/.4/.5 should reference the `tier_definitions` columns and treat the listed numbers as "launch defaults" only.

### §15.5 / §14.5 — Hold periods + split rates
- **Spec said:** 7/3/0-day hold periods for Starter/Pro/Agency; 30/25/20% platform split rates.
- **Reality:** Already in `tier_definitions.hold_period_days` + `.platform_split_rate` (migration `20260525000000_money_columns.sql`). Operator-tunable.
- **Action for spec update:** §15.5 / §14.5 should reference the DB columns.

---

## 4. Runtime decisions (not in spec)

Implementation-level choices that deviate from the spec's prose but are deliberate.

### Node.js version
- **Spec said:** Node.js 22.x.
- **Reality:** Node.js 24 LTS across the monorepo.
- **Why:** Node 24 is the current LTS, Vercel Fluid Compute supports it natively, broader perf wins, no spec-relevant API changes from 22→24.
- **Source:** MEMORY D-027.
- **Action for spec update:** §1 / §2 runtime callouts → "Node.js 24 LTS."

### Middleware runtime
- **Spec said:** Edge runtime (`runtime = "edge"`) for `apps/main/src/middleware.ts`.
- **Reality:** Default runtime (Node.js under Fluid Compute on Vercel; locally edge-compatible). `@supabase/supabase-js` v2 is edge-compatible so no explicit runtime annotation needed.
- **Source:** MEMORY D-038, file docstring.
- **Action for spec update:** §1.4 / §3.6 runtime callout → "default runtime; Vercel deploys under Fluid Compute."

### Vercel project names
- **Spec said:** Generic `apps/main` and `apps/rag` project names.
- **Reality:** `atc-main` and `atc-rag` on Vercel.
- **Source:** MEMORY D-029.
- **Action for spec update:** §1 / appendix env var listings should use the real project names.

### Singular VERCEL_PROJECT_ID
- **Spec said:** Two project IDs (one per app).
- **Reality:** Single `VERCEL_PROJECT_ID` pointing at `atc-main`. RAG deploy is a separate workflow.
- **Source:** MEMORY D-030.
- **Action for spec update:** Env appendix.

### correlation_id format
- **Spec said:** ULID (sortable identifier).
- **Reality:** `crypto.randomUUID()` (UUIDv4). Loses sort-by-time but gains zero-dep + native availability.
- **Source:** MEMORY D-035.
- **Action for spec update:** Any place ULID is mentioned should be UUIDv4.

### tenantClient Proxy implementation
- **Spec said:** Exact code shape in §5.4.3 for the tenant proxy.
- **Reality:** Proxy in `apps/main/src/lib/db/tenant-client.ts` deviates from the verbatim spec code — adds RLS allowlist check, structured `UnregisteredTenantTableError`/`UnscopedTenantClientMethodError`. Same contract, defensively richer implementation.
- **Source:** MEMORY D-034.
- **Action for spec update:** §5.4.3 prose stands; code block should be marked "illustrative — see `lib/db/tenant-client.ts` for live implementation."

### tenant_registry table rename
- **Spec said:** `tenant_registry` table on the RAG side.
- **Reality:** Renamed to `tenant_registry_shadow` to reflect that it's a synced replica, not the source of truth.
- **Source:** MEMORY D-043.
- **Action for spec update:** §8.3 / RAG schema.

### platform_settings as RAG replica
- **Spec said:** Either shared DB or independent settings.
- **Reality:** `platform_settings` lives in atc-main; a Stripe-event-driven publisher syncs a subset to RAG's own `platform_settings` table (replica). Option C from the BP06 decision matrix.
- **Source:** MEMORY D-041, D-078.
- **Action for spec update:** §8 should document the sync-publisher pattern.

### BP05 schema — deferred FKs + custom RLS
- **Spec said:** Standard cascading FKs throughout.
- **Reality:** Several FKs deferred to avoid create-order coupling (e.g. `help_sessions.conversation_id` FK-less). `stripe_webhook_events` has custom RLS (not standard four-policy) because it's written by the webhook handler under service-role with no tenant context. `payout_balances` has a composite PK instead of UUID.
- **Source:** MEMORY D-040.
- **Action for spec update:** §5 schema callouts.

### BP09 — pgvector retrieval via RPC
- **Spec said:** Inline `<=>` operator on the SQL builder.
- **Reality:** A Postgres function (`retrieve_chunks`) wraps the vector op so PostgREST can call it via `.rpc()`. PII separator backreference quirk also documented. `submitted_by_user_id` is nullable to support batch-API ingestion with no triggering user.
- **Source:** MEMORY D-044.
- **Action for spec update:** §8 / §22 retrieval implementation.

### no-direct-service-role-import lint rule
- **Spec said:** Use `tenantClient(ctx)` or `withPlatformAdminAudit(...)` for DB access.
- **Reality:** Enforced via a custom ESLint rule (`packages/config/eslint-rules/no-direct-service-role-import.js`) with an explicit allowlist of files (~280 entries) that have a justified reason to import the raw service-role client (webhook handlers, Inngest jobs, etc.). The allowlist itself is the audit trail.
- **Source:** MEMORY D-045.
- **Action for spec update:** §5.4.4 should reference the lint rule + allowlist file.

### `tenantContextForPlatformAdmin` deprecated
- **Spec said:** Factory function for cross-tenant admin access.
- **Reality:** Superseded by `withPlatformAdminAudit` helper; old factory throws "superseded by withPlatformAdminAudit." Kept as a tripwire for any caller still on the old API.
- **Source:** PR #184.
- **Action for spec update:** §5.4.5 should describe the wrapper pattern.

### §33.7.2 — Display-asset rendering: hyperlink, not inline `<img>`
- **Spec said:** Client renders each `[[display_asset:<uuid>]]` markup as an inline `<img>` element with `src = image_url`, `alt = caption`, `referrerpolicy="no-referrer"`, and a visible attribution credit beneath the image.
- **Reality:** Client renders each marker as an `<a>` hyperlink (`View deck plan ↗`) with the attribution as an adjacent text node. No `<img>` element is generated in the chat surface. The spec's §33.7.3 fallback escape hatch (tool-call shape with "identical user-visible behavior") covers the deviation in principle, but the user-visible behavior is meaningfully different — customers see a clickable link, not an embedded image.
- **Why:** Operator decision to avoid hot-linked image bandwidth, mixed-content edge cases, and the chat-surface UI footprint of an embedded image. The hyperlink keeps source attribution visible and lets the customer opt into the visual.
- **Source:** MEMORY D-075. Wired in BP39 / §33.7.1 (`apps/main/src/lib/ai/display-assets-block.ts`) and BP39 client renderer (`apps/main/src/components/chat/renderMessageContent.tsx`).
- **Action for spec update:** §33.7.2 should add a `> **Status (2026-05-25):** Rendered as `<a>` hyperlinks, not inline `<img>`. See `docs/specs/reality-delta.md#§33.7.2` and MEMORY D-075.` callout. The `referrerpolicy` requirement becomes N/A; the `rel="noopener noreferrer"` requirement applies to the link instead.

### §13.9 — Host-adapter health monitoring: reactive-only, no active probe cron
- **Spec said:** Cron checks every active `tenant_host_configs` row's credential health, marks status (active / degraded / rejected). Banner surfaces.
- **Reality:** No active-probe cron exists. Health is inferred reactively from decryption failures + Inngest job errors via `lib/host-adapters/credential-health.ts`. The banner-resolution logic is wired but reads audit_log signals rather than a status field maintained by a cron.
- **Why (operator decision 2026-05-26):** Host-adapter call volume is moderate. A broken credential surfaces within minutes of the next real call (every booking submit, every commission reconciliation cron). A nightly active probe would add Inngest invocations + adapter API hits for tenants whose failure would surface organically anyway. Reactive is cheaper, less noisy, and equivalent in practice at this call volume.
- **Revisit if:** (a) host-adapter call volume drops such that real signal arrives slowly, or (b) a real incident proves the reactive path is too slow.
- **Source:** MEMORY D-087.
- **Action for spec update:** §13.9 should add a `> **Status (2026-05-26):** Reactive-only inference at launch. Active probing deferred to a future iteration once real call volume signals a need.` callout.

### §33.12 — Sample-OCR Haiku-vision evaluation: deferred
- **Spec said:** Build-order step 9 — run Haiku vision on a 200-image sample of CruiseMapper deck plans + ship photos, measure uplift over text-only descriptions, decide whether to ship the OCR uplift.
- **Reality:** No evaluation run. Text-only chunks ship and are retrievable.
- **Why (operator decision 2026-05-26):** Text-only chunks already serve the bulk of deck-plan / ship questions. The OCR uplift is incremental and the calibration time (designing the quantitative bar, curating the question set, scoring the responses) is the real cost — not the ~$10–20 of Haiku-vision spend. Re-evaluate once there's customer-question signal that text-only RAG isn't satisfying.
- **Source:** MEMORY D-087.
- **Action for spec update:** §33.11 build-order step 9 should add `> **Status (2026-05-26):** Deferred until customer-question signal indicates text-only RAG insufficient.`

---

## 5. Security changes from audits

Changes driven by security audits — five waves total. The spec needs threat-model + control prose updated to match.

### §26.2 — RBAC enforcement (audit fix)
- **Spec said:** `assertPermission(req, { resource, action })` checks role grants from `permission-grants.ts`.
- **Pre-audit reality:** assertPermission STUBBED — logged the (resource, action) pair and proceeded. Every "permission-gated" mutating route was open to any active tenant member regardless of role. Confirmed by 2026-05-25 audit Finding 5 (Medium severity).
- **Reality (post-audit):** Real RBAC matrix in `permission-grants.ts` (51 grants across tenant_owner / agent / viewer). Stub closed. `AuthForbidden` thrown when role lacks grant → 403 via `respondToAuthError`.
- **Source:** MEMORY D-083, file docstring.

### §26 — Admin gate via assertPlatformAdmin (audit fix)
- **Spec said:** Platform admin endpoints gated by some admin-session check.
- **Pre-audit reality:** Trusted `x-admin-user-id` header. ANYONE who could craft a request with that header was an admin. Audit Finding 1 (confidence 10).
- **Reality (post-audit):** Two-layer gate: middleware shape-checks an Authorization Bearer; route handlers call `assertPlatformAdmin(req)` which verifies the JWT signature + looks up `platform_admins` row. Service-to-service uses `MAIN_APP_ADMIN_API_KEY` constant-time-compared.
- **Source:** MEMORY D-059 (BP26), D-083.
- **Action for spec update:** §26 / §26.3 should describe the two-layer gate.

### §26.5 — Audit log writes via writeAuditLog (audit fix)
- **Spec said:** Audit log writes on every significant action.
- **Pre-audit reality:** Many call sites used `console.warn` stubs with `[audit-log:STUB]` markers (D-036). Forums message moderation wrote to `audit_log` with the WRONG column schema (`category`/`details` instead of `action`/`resource_type`/`changes`) — silently failing.
- **Reality (post-audit):** Single `writeAuditLog(row)` helper at `lib/audit/write.ts`. Every prior stub call site swapped to the real call. Forums fixed. Quotes accept had a `logQuoteAuditStub` shim inlined to direct `writeAuditLog` with correct `actor_type='user'`. Bookings submit had a `logAuditStub` shim removed.
- **Source:** PR #183, PR #184. MEMORY D-059, D-036.
- **Action for spec update:** §26.5 should describe the helper API + the fail-loud-on-error posture.

### §17.4 — Consent gate enforced (this session, PR #199)
- **Spec said:** Global middleware redirects ANY authenticated request other than `/consent`, `/logout`, `/legal/*` to `/consent` when `user_consent_pending` has rows.
- **Pre-fix reality:** Everything around the gate existed — publish flow writes rows, `/consent` page renders + accepts, email blast notifies — but the actual enforcement was missing. Users could keep using the app despite published new versions.
- **Reality (post-fix):** Gate enforces in `assertPermission` (not middleware) because the codebase's auth posture keeps access tokens in localStorage rather than cookies. Middleware can't see who's authenticated without a Supabase round-trip. assertPermission checks `getConsentPending(auth_user_id)` after bearer verification; throws `ConsentPendingError` if any. `respondToAuthError` maps to 403 + `{ error: "consent_pending", return_to, pending }` so clients can route to `/consent`. The two consent endpoints (`/api/user/consent`, `/api/user/consent/pending`) use Supabase auth directly (not assertPermission) so they're naturally exempt.
- **Source:** PR #199 (this session).
- **Action for spec update:** §17.4 should reflect the assertPermission-level enforcement and mention WHY (localStorage token posture). If a future change moves auth to cookies, the spec's middleware-level gate becomes implementable.

### §35.10 — Cookie consent
- **Spec said:** Cookie consent banner with refusal suppressing tracking.
- **Reality:** Implemented via `atc_cookie_consent` cookie (`rejected` value) checked in middleware to skip attribution capture. UI banner exists.
- **Source:** `apps/main/src/middleware.ts` line 32+, MEMORY D-057.
- **Action for spec update:** No deviation; just confirming wiring.

### §13.5.3 — Credential decryption forensic hash
- **Spec said:** Every decryption failure writes an audit row with a forensic identifier.
- **Reality:** SHA-256 hash of the AES-GCM ciphertext is the identifier. CodeQL initially flagged this as "insufficient password hash" (`js/insufficient-password-hash`); dismissed as false-positive — we're not hashing a password, we're correlation-hashing already-encrypted bytes. The actual cred is encrypted via AES-256-GCM with key from `APP_ENCRYPTION_KEY_*`.
- **Source:** PR #195 (CodeQL alert #4 dismissed), MEMORY D-084.
- **Action for spec update:** §13.5.3 should mention the forensic hash and explicitly note it is NOT a password hash.

### CodeQL log-injection sanitization
- **Spec said:** (not specified)
- **Reality:** User-controlled values flowing into `console.*` calls are sanitized inline with `String(v).replace(/[\r\n]/g, ' ')` to prevent log forgery. 4 sites: admin/legal-docs, onboarding/legal, resend webhook ×2. Replaced a helper-based approach that CodeQL's taint tracker couldn't follow.
- **Source:** PR #195, PR #196.
- **Action for spec update:** Add to §28 (env / config) or §25 (operations) as a sanitization standard.

### CodeQL URL redirect sanitization (consent page)
- **Spec said:** (not specified)
- **Reality:** `/consent` page's post-acceptance `return_to` redirect validates via `new URL(candidate, location.origin)` + `parsed.origin === location.origin` and rebuilds from `pathname + search + hash` only. Rejects protocol-relative (`//evil.com`) and absolute external URLs.
- **Source:** PR #195, PR #196.

### CodeQL SSRF mitigation (bulk-approve)
- **Spec said:** (not specified)
- **Reality:** `/api/rag/queue/bulk-approve` per-item POST origin derived from `NEXT_PUBLIC_APP_URL` / `PLATFORM_PRIMARY_DOMAIN` env, not from `req.url`. Forged Host header can't redirect the per-item POSTs at an attacker server.
- **Source:** PR #195.
- **Action for spec update:** §22.5 bulk-approve flow should mention the trusted-origin requirement.

---

## 6. Schema / migration deviations

Things where the live schema differs from spec SQL.

### `tier_definitions` schema additions
- **Spec said:** `tier_definitions(id, code, display_name, …)`.
- **Reality (after PR #189):** Additional columns `chat_base_monthly`, `email_base_daily`, `group_invite_base_monthly`, `rag_base_chunks` (all NOT NULL, default 0). Plus existing columns `platform_split_rate`, `hold_period_days`, `max_seat_count`, `is_sub_host` from earlier migration.
- **Migration:** `apps/main/supabase/migrations/20260625000004_tier_definitions_abuse_bases.sql`.
- **Action for spec update:** §3.3 + §27.4 schema should list all columns.

### `gmail_oauth_tokens` table
- **Spec said:** Implicit — Gmail integration described but storage shape not nailed down in §23.9 / §34.2.
- **Reality:** Standalone table `gmail_oauth_tokens` in `apps/main` with `encrypted_refresh_token` (base64 ciphertext via `credential-cipher`), `encryption_key_version`, `health_status` enum, `pubsub_watch_expires_at`, `pubsub_history_id`, `connected_email`.
- **Migration:** `apps/main/supabase/migrations/20260617000000_bp34_phase_c_gmail_storage.sql`.
- **Action for spec update:** §34.2 should include the schema.

### `audit_log.context` column
- **Spec said:** Audit shape didn't formally distinguish "changes" from "context."
- **Reality:** Two JSONB columns — `changes` (the delta) and `context` (request metadata, IP, etc.) — both nullable. Distinction is enforced via the `writeAuditLog({ row })` signature.
- **Action for spec update:** §26.5 schema callout.

### `pii-quarantine-aggregator` consumer pending
- **Spec said:** Aggregation feeds §27 abuse signal.
- **Reality:** Aggregator writes; consumer in §27 is `TODO until §27 ships` — but §27 DID ship (BP27/BP28). Marker is stale. Actual consumer is the abuse counter / snapshot aggregation; the BP27 description in the marker is what's stale.
- **Source:** `apps/main/src/lib/rag-ingest/pii-quarantine-aggregator.ts`.
- **Action for spec update:** Update marker + cross-link.

### `knowledge_chunks.ingest_user_id`
- **Spec said:** CCPA export should include user-submitted RAG chunks.
- **Reality:** `ingest_user_id` UUID column added to `knowledge_chunks` in RAG migration `0009_post_termination.sql`. CCPA export now fetches via `/api/admin/export-user-chunks` (PR #187).
- **Action for spec update:** §17.9 schema reference.

### `user-exports` storage bucket
- **Spec said:** CCPA export uploads to Supabase Storage; bucket name `user-exports`.
- **Reality:** Bucket auto-provisioned at first export via `ensureBucket()` helper (PR #187). Previously required manual operator setup.
- **Action for spec update:** §17.9 should note the auto-create.

---

## 7. API contract deviations

### `/api/admin/ai-pricing` — operator-managed pricing
- **Spec said:** §27.12 implied an auto-fetch path.
- **Reality:** New endpoint `GET/PUT /api/admin/ai-pricing`. GET returns defaults + override + effective merge. PUT validates non-negative integers per model and writes to `platform_settings.ai_pricing_catalog`. Wrapped in `withPlatformAdminAudit` for auditability.
- **Source:** PR #191.
- **Action for spec update:** §27.12 should document the endpoint contract.

### `/api/imports/review/[id]/merge` — field-level merge
- **Spec said:** BP34 §34.6 listed "Merge with existing" as a fourth action; merge semantics not detailed.
- **Reality:** New endpoint accepts `{ target_contact_id }`. Field-level non-destructive merge: for each mergeable text field, if existing is blank → fill from import; otherwise leave alone. Notes always append with a `--- Imported YYYY-MM-DD ---` provenance line. Rejects `commission_statement` document type. Marks queue row accepted with `_merge` metadata. Writes audit_log.
- **Source:** PR #193.
- **Action for spec update:** §34.6 should describe the merge contract.

### `/api/admin/replace-chunk` (RAG) — new endpoint
- **Spec said:** §22.12 referenced replace mode; RAG-side endpoint shape implicit.
- **Reality:** `POST /api/admin/replace-chunk` body `{ chunk_id, content, source_url?, category? }`. Re-runs zero-tolerance PII pre-filter (prevents laundering PII via replace path), re-embeds, in-place update preserving `id`/`scope`/`tenant_id`/`created_at`. Scope-aware auth: tenant chunks require matching JWT tenant_id; global chunks require `service_identifier=platform-admin`.
- **Source:** PR #188.
- **Action for spec update:** §22.12 should reference the endpoint.

### `/api/admin/demote-chunk` (RAG) — new endpoint
- **Spec said:** §22.8 demote referenced `/demote/chunk/:id`; not shipped on RAG side until PR #186.
- **Reality:** `POST /api/admin/demote-chunk?id=&mode=` with platform-admin gate. Modes: `to_tenant_scope` (flip scope back), `hard_delete` (remove row).
- **Source:** PR #186.

### `/api/admin/export-user-chunks` (RAG) — new endpoint
- **Spec said:** §17.9 CCPA export should include knowledge_chunks; mechanism left implicit.
- **Reality:** `POST /api/admin/export-user-chunks` with `{ auth_user_id }`. Platform-admin only. Returns chunks where `ingest_user_id = auth_user_id`. Called by main-side `user-data-export-build` Inngest job via signed service JWT.
- **Source:** PR #187.

### Stripe webhook handlers — all wired
- **Spec said:** §7.9a Stripe webhook contract.
- **Pre-fix reality:** Handler header comment claimed "all TODO stubs for now" (MEMORY D-042); in reality 7 event types were already wired by various BPs.
- **Reality (post-fix):** Doc refresh + `customer.subscription.created` added to the same handler as `updated`/`deleted` (PR #190). Wired events: `transfer.paid`, `checkout.session.completed`, `account.updated`, `customer.subscription.{created,updated,deleted}`, `invoice.payment_{succeeded,failed}`.
- **Action for spec update:** §7.9a should list all wired event handlers.

### Chat sidebar — three tabs wired
- **Spec said:** Customer chat sidebar with History, Memory, Preferences.
- **Pre-fix reality:** `display: none` stub.
- **Reality (post-fix):** Full implementation. History fetches `/api/chat/conversations` (last 20). Memory renders `/api/memory` JSONB sections read-only. Prefs has tone-level slider (1–5) + notes textarea, PATCHes `/api/memory`.
- **Source:** PR #194.

---

## 8. Spec inaccuracies clarified by implementation

Cases where the spec was ambiguous and implementation pinned down the interpretation.

### §32.4.3 — Bug/feature flow state persistence
- **Spec ambiguity:** Didn't say how to persist state across SSE chat turns.
- **Implementation:** State derived from count of prior user messages in the session's conversation (the bot asks each step's question exactly once → count = position in `BUG_FLOW_STEPS` / `FEATURE_FLOW_STEPS`). Draft reconstructed by replaying prior messages through the state machine. No new persistence table needed.
- **Source:** PR #186.
- **Action for spec update:** §32.4.3 should document the derivation pattern.

### §27.4 — Abuse threshold scaling
- **Spec ambiguity:** "Scale base by tier" — exact formula not specified.
- **Implementation:** `scale(base) = base * effectiveMonthlyRevenueCents / tierReferenceRevenueCents`. Override rows from `tenant_usage_overrides` replace specific thresholds; tier_definitions provides base counts.
- **Source:** `lib/abuse/thresholds.ts`, MEMORY D-060.
- **Action for spec update:** §27.4 formulas section.

### §17.9 — CCPA export 45-day SLA
- **Spec ambiguity:** What happens if RAG service is down during export?
- **Implementation:** Non-fatal — knowledge_chunks export failure recorded as `knowledge_chunks_error` in payload; user still gets the rest of their data within SLA.
- **Source:** PR #187.

### `lib/consent/pending.ts` docstring corrected
- **Pre-fix:** "Used by layout components and assertPermission to gate access."
- **Reality (pre-PR-#199):** Used by NEITHER. Layout wiring never happened, assertPermission didn't import it.
- **Reality (post-PR-#199):** Used by assertPermission. Layout wiring intentionally NOT done (auth posture mismatch — see §17.4 entry in §5 above).

---

## 9. Open spec gaps still to be wired

Things the spec describes but that have no implementation yet. Different from §1/§2 because these aren't deferred decisions — they're just incomplete.

### `lib/abuse/enforcement.ts` — per-dimension behaviors
- **Spec:** §27.6 per-dimension enforcement behaviors.
- **Status:** Library file exists with structural scaffolding but no callers. AI cost enforcement is currently in the wrapper (`selectModelForPurpose`); hard-state blocking is at the chat path. Other dimensions deferred.
- **Action:** Either wire the file in or remove it. Knip flagged it as unused.

### `lib/tasks/sequence-engine.ts` — task sequence engine
- **Spec:** BP37 §37.4.2 sequence engine triggered by CRM pipeline events.
- **Status:** Library exists and is complete; downstream `task-sequence-step-fire` Inngest job consumes its emitted events. The CRM-side TRIGGER call sites (contact create/update, quote send/accept, booking create/confirm) don't call this yet — that fan-out is the remaining BP37 work, scheduled alongside CRM pipeline-transition refactors.
- **Action:** When the CRM endpoints get their pipeline-transition refactor, add `triggerMatchingSequences()` calls at each transition. Engine is unchanged.

### Breach notification (lib + templates + dispatcher)
- **Spec:** §25.9 breach response with SLA-driven dispatch.
- **Status:** `lib/email/send-breach-notifications.ts`, `emails/BreachNotification{User,TenantAdmin}.tsx` all exist with `TODO(legal-counsel)` placeholders. Dispatcher not wired into any incident workflow.
- **Action:** Wait for legal counsel + define incident-trigger surface. Wording TODO blocks code wiring; code is otherwise ready.

### Branding / attribution: `LegalPageAttribution` + `UndoBanner`
- **Spec:** §16.7.1 always-on attribution on every `/legal/*` page; §11.6 persistent undo banner at top of `/settings/conversations`.
- **Status:** Components exist but their HOST PAGES don't exist yet in the tenant-context form they need:
  - `LegalPageAttribution` requires a tenant-scoped `/legal/*` route (current `/legal/sub-processors` and `/legal/ai-disclaimer` are platform-public, no tenant_display_name in context).
  - `UndoBanner` requires a `/settings/conversations` page; that route doesn't exist.
- **Action:** Build the host pages first (tenant-context `/legal/*` route group + `/settings/conversations` page), then mount the components. Each is a small page-add, not a layout edit.

### BP39/BP40 editor components
- **Spec:** §39.7 itinerary editor, §39.7 resources editor, §40.5.1 line items panel.
- **Status:** Components exist but the booking-detail page `(tenant)/crm/bookings/[id]/page.tsx` doesn't exist yet — there's no surface to mount them on.
- **Action:** Build the booking-detail page first, then mount the three editor panels into it.

### Gmail integration (PR #192) — OAuth start flow
- **Spec:** §23.9 / §34.2 Gmail OAuth.
- **Status:** Pub/Sub webhook + health endpoint live. Encryption + storage live. OAuth start flow (`/api/integrations/gmail/connect`) returns 501. Runbook complete at `docs/runbooks/gmail-inbound-setup.md`.
- **Action:** When operator provisions the GCP project, implement Step 5 of the runbook (redirect to Google consent, callback exchange, encrypted token storage, `users.watch()`).

### Gmail callback route (`/api/integrations/gmail/callback`)
- **Spec:** Implicit in §23.9 OAuth flow.
- **Status:** Doesn't exist. Currently no callback route to receive the OAuth code.
- **Action:** Implement alongside Step 5 of the Gmail runbook.

### Booking flow customer UI (§20.2)
- **Spec:** Customer 4-stage booking flow.
- **Status:** Pages are stubs with `TODO(prompt-24)` markers.
- **Action:** Wait for prompt-24.

<!-- Compliance nightly ICA version check — CLOSED 2026-05-25 in feat/wire-actionable-gaps.
     The cron now queries legal_documents for the current ica_subhost version and
     flips tenants.requires_ica_reacceptance when their last accepted version is
     stale. Belt-and-suspenders to the publish-time flag in /admin/legal-docs. -->

<!-- lib/supervisor/sample-for-review.ts — CLOSED 2026-05-25 in feat/wire-actionable-gaps.
     Wired into run-supervisor.ts after the messages.supervisor_findings update;
     escalations always insert, other categories sampled at rates from
     platform_settings (defaults: clean_pass 1%, warning_pass 10%, regen 25%).
     Call is wrapped in try/catch — sampling failure must not crash the pipeline. -->

<!-- PoweredBy mounted in /chat customer surface 2026-05-25 in feat/wire-actionable-gaps.
     Currently show=true as a placeholder; future variant should resolve
     tenant_branding.show_powered_by per-tenant (server-coerced TRUE on the
     BYO Research / BYO Professional / Sub-Host Starter tier floor per §16.7). -->

---

## Process notes

- **MEMORY.md is the canonical decision log.** This file is a derived view organized for spec maintenance. When the two disagree, MEMORY.md wins for "why," this file wins for "what shape did the implementation actually take."
- **Don't update entries in-place when more changes land.** Add a new sub-entry with a date stamp. The spec-update pass should incorporate the latest entry.
- **PR numbers refer to the GitHub repo `jharvieux/ATC`.** Spec updates should link back to the PR for context.
- **When the spec is updated to match an entry, mark the entry with `> **Spec updated YYYY-MM-DD in commit XXXXX**` rather than deleting it** — gives auditors a paper trail.

---

# Appended 2026-05-27 — second full-spec sweep findings

The sections below were appended after a read-every-line sweep against current `dev` state (see `docs/specs/reality-delta-supplement-2.md` for the sweep notes). They follow the same conventions as §1–§9 above. They are appended rather than interleaved into §4/§6/§8 so the original entries stay byte-identical.

---

## 10. Runtime decisions (not in spec) — second pass

These extend §4 with deviations the original delta missed.

### Next.js version: spec says 14, reality is 16
- **Spec said:** §1.2 / §2.1 / §29.2 — "Next.js 14 (App Router)" across the topology, stack, and deployment sections.
- **Reality:** Next.js 16 across both apps after the framework bump. Forced by upstream upgrade; surfaced the Next 16 instrumentation timing cascade (D-101) and the middleware → proxy rename below.
- **Source:** MEMORY D-101 (instrumentation cascade), PR #323 (middleware → proxy file rename was the most visible artifact).
- **Action for spec update:** §1.2 ASCII diagram, §2.1 stack table, §29.2 build settings table — change all "Next.js 14" references to "Next.js 16."

### `middleware.ts` → `proxy.ts` file rename (Next 16 deprecation)
- **Spec said:** §1.4 and §3.6 reference `apps/main/src/middleware.ts` and a function named `tenantResolverMiddleware`.
- **Reality:** Next 16 deprecated the `middleware.ts` filename convention. File is `apps/main/src/proxy.ts`; function is `tenantResolverProxy`. Stryker config + test file + one comment path-reference also updated in the same PR.
- **Source:** PR #323.
- **Action for spec update:** §1.4 / §3.6 code excerpts — change `middleware.ts` to `proxy.ts`, `tenantResolverMiddleware` to `tenantResolverProxy`. The "runs in middleware" prose still reads correctly because middleware-as-concept is unchanged; only the filename + function name moved.

### `SERVICE_JWT_*` env vars (spec writes `INTER_SERVICE_JWT_*`)
- **Spec said:** §28.4 lists `INTER_SERVICE_JWT_PRIVATE_KEY`, `INTER_SERVICE_JWT_PUBLIC_KEY`, `INTER_SERVICE_JWT_KEY_ID`, `INTER_SERVICE_JWT_TTL_SECONDS`, `INTER_SERVICE_JTI_CACHE_URL`, `INTER_SERVICE_JWT_PUBLIC_KEY_PREVIOUS` (for rotation overlap).
- **Reality:** Code uses `SERVICE_JWT_PRIVATE_KEY`, `SERVICE_JWT_KEY_ID`, `SERVICE_JWT_TTL_SECONDS`. Rotation overlap is done via `SERVICE_JWT_ACCEPTED_KEY_IDS` (comma-separated kid allowlist) rather than `_PUBLIC_KEY_PREVIOUS`. JTI cache uses the generic `REDIS_URL`, not a dedicated `INTER_SERVICE_JTI_CACHE_URL`.
- **Source:** `apps/main/src/lib/env.ts:70-74`, `apps/rag/src/lib/auth/verify-service-jwt.ts:30-95`. Tracked in `docs/env-audit.md` with a "scope flag" noting the rename touches RAG + GitHub Actions + Vercel env vars (operator-side).
- **Action for spec update:** Either (a) drop the `INTER_` prefix in §28.4 and replace `_PUBLIC_KEY_PREVIOUS` with `_ACCEPTED_KEY_IDS`, or (b) schedule the rename as a coordinated env migration (touches main+RAG+CI+Vercel) — see env-audit.md for the rename scope.

### `RAG_SERVICE_URL` env var (spec writes `PLATFORM_RAG_SUBDOMAIN`)
- **Spec said:** §28.1 — `PLATFORM_RAG_SUBDOMAIN` (subdomain-shaped).
- **Reality:** `RAG_SERVICE_URL` (full URL, not subdomain). Equivalent surface; different shape.
- **Source:** `docs/env-audit.md`.
- **Action for spec update:** §28.1 should use `RAG_SERVICE_URL` and note it's the full URL.

### `PLATFORM_TENANT_SUBDOMAIN_BASE` env var — does not exist in code
- **Spec said:** §28.1 — required env var.
- **Reality:** Code derives tenant subdomains from `PLATFORM_DOMAIN_REGEX` matched against `PLATFORM_PRIMARY_DOMAIN`. The base-domain string is computed, not configured.
- **Source:** `docs/env-audit.md`.
- **Action for spec update:** §28.1 — either remove `PLATFORM_TENANT_SUBDOMAIN_BASE` and document the regex-based equivalence, or schedule adding the explicit var.

### `INNGEST_SIGNING_KEY` is required at boot (cascade from D-101)
- **Spec said:** §28.11 — listed as required.
- **Reality matches spec** but is worth recording explicitly because Next 16's instrumentation timing means missing this (or any other spec-listed required var) crashes the dev server within milliseconds of "Ready." PR #307 hit this on the Vercel build phase; PR #320 hit it on the e2e workflow.
- **Source:** MEMORY D-101.
- **Action for spec update:** §28.19 boot verification subsection should add a "Next 16 timing" callout — env validation now runs deterministically on every Node startup including `next dev`, so any unset required var fails-loud immediately.

### §15.13 — 180-day auto-suspend deliberately disabled for paying tenants
- **Spec said:** "Inactive sub-host: 30/60/90/180-day nudges; auto-downgrade or suspend at 180 days inactivity."
- **Reality:** `apps/main/src/inngest/compliance-nightly.ts` head comment (lines 14-20) explicitly says: "No 180-day auto-suspend for inactive PAYING tenants. The user's framing: paying customers shouldn't lose access because they're not using the app. The 180d level row stays in NUDGE_LEVELS as a final reminder; the suspend branch is gone." The 180d level is a log breadcrumb only — no email, no suspension. Non-paying past-grace tenants are handled via middleware redirect + a separate cron, not this branch.
- **Source:** PR #121 (referenced in the cron's comment).
- **Action for spec update:** §15.13 should add `> **Status:** 180-day auto-suspend deliberately disabled for paying tenants per PR #121. 180d level is now a log-only breadcrumb. Non-paying past-grace handled by middleware redirect, not this cron.`

---

## 11. Architecture additions (Greptile / D-091 follow-ons) — spec sync needed

These are the architectural primitives that landed across the three D-091 audit rounds. They have a dedicated spec addendum at `specs/TechSpec/spec-addendum-d091-hardening.md` and aren't strictly missing from the spec — but the **main sections they affect (§5.4, §7.9a, §14.7, §17.9, §22.4, §24, §27.12, §32) still reference the pre-D-091 patterns**. The action below names which main-spec sections need a callout pointing at the addendum.

### `safeAwait` mutation wrapper (D-094)
- **Where:** `apps/main/src/lib/db/safe-mutation.ts`.
- **Why:** Supabase JS v2 returns `{ error }` tuples instead of throwing. Roughly 113 unchecked-mutation sites across the codebase silently swallowed DB errors.
- **Lint:** `atc/no-unchecked-supabase-mutation` at `error` repo-wide after migration PRs #271/#272/#273.
- **Action for spec update:** §5.4 should add a callout — `safeAwait(query, "context.label")` is the canonical Supabase mutation pattern; the previously-allowed destructured-`{ error }` pattern is now lint-restricted to `safe-mutation.ts` itself. Cross-reference `spec-addendum-d091-hardening.md` §2.1.

### `safeAwaitRowCount` for CAS-style status guards (D-091 round 2)
- **Where:** `apps/main/src/lib/db/safe-mutation.ts`.
- **Why:** Supabase JS `.update().eq("status", X)` returns `{ error: null }` whether 0 or N rows matched. Every CAS lock pattern needs `.select("id")` + row-count assertion.
- **Action for spec update:** §14.7 (Stripe transfer lock), §22.12 (RAG re-ingest), §15.x (onboarding state machine), §18.5 (invitation first-use binding) — each should reference the `safeAwaitRowCount` pattern. Same addendum cross-ref.

### Conversation history helper (D-095)
- **Where:** `apps/main/src/lib/chat/conversation-history.ts`.
- **Why:** Prior chat / help-AI calls passed only the current user message — every turn was stateless. Customers thought the AI "forgot" prior turns.
- **Two-layer isolation:** helper requires `tenantId` positional arg + uses both `.eq("tenant_id", …)` and `.eq("conversation_id", …)` so service-role bypass of RLS still has the second filter.
- **Action for spec update:** §24 should describe the multi-turn history shape + alternation guard. Same addendum cross-ref.

### Atomic increment RPC for tenant AI cost (D-094 follow-up)
- **Where:** `apps/main/supabase/migrations/20260627000000_tenant_usage_atomic_increment.sql` defines `increment_tenant_ai_cost(tenant_id, billing_period, amount_cents)` as `SECURITY DEFINER` with `search_path = ''`.
- **Why:** Replaces the prior read-then-write TOCTOU in `lib/ai/call-wrapper.ts:logAndIncrement` that — after `safeAwait` started surfacing errors — would make a successful AI call appear to fail under concurrent first-period inserts.
- **Action for spec update:** §27.12 cost-attribution prose should reference the RPC and the `SECURITY DEFINER` discipline from §5.1.1.

### Error-injection probe (`apps/main/test/error-injection/`)
- **Where:** Dedicated CI step `pnpm test:error-injection` runs alongside lint/typecheck/build.
- **What:** Forces handlers into DB-error / resource-down / concurrent-execution failure modes that happy-path tests don't exercise.
- **Coverage table:** `apps/main/test/error-injection/README.md`.
- **Action for spec update:** §30 (Testing Requirements) should add a §30.X for error-injection probes alongside the cross-tenant probe and the cross-tenant Inngest probe.

### Round-3 #43 chat kill switch in streaming mode — FIXED but addendum says "pending"
- **Where:** `apps/main/src/app/api/chat/route.ts:543-565`. Kill switch now checked BEFORE the stream is acquired.
- **Why this entry exists:** `specs/TechSpec/spec-addendum-d091-hardening.md` §3 footnote on §10.6 says "still pending implementation as of this addendum" — the addendum is stale.
- **Action for spec update:** Update spec-addendum-d091-hardening.md §3 §10.6 footnote to mark this fixed. Pattern catalog (§6 of addendum) item 14 (Kill-switch gap in streaming) should be marked closed.

### Round-3 #47 quote price-lock expiry — FIXED but cross-round table says "Tier-1 quick win"
- **Where:** `apps/main/src/app/api/quotes/[id]/accept/route.ts:83-89`. Confirmed-quote acceptance now rejects if `price_lock_expires_at` is past.
- **Action for spec update:** `docs/runbooks/audit-followups-2026-05-26.md` should mark #47 closed; the addendum's "Recommended Tier-1 additions" list should mark it shipped.

---

## 12. Spec internal inconsistencies (caught during the sweep)

These are places where one part of the spec contradicts another part of the same spec, or contradicts the live migration. They aren't deviations from spec — they're internal-to-spec bugs that should be fixed in the spec text.

### §12.4 quotes schema — `NUMERIC(12,2)` money columns still in spec text
- **Spec §12.4:** Schema block shows `commissionable_fare NUMERIC(12,2)`, `non_commissionable_total NUMERIC(12,2)`, `total_amount NUMERIC(12,2)`.
- **Spec §14.0.1:** "All money columns store integer cents as BIGINT. No NUMERIC money columns. No DECIMAL money columns."
- **Reality:** Migration `20260621000000_bp38_quote_options_expand.sql` added parallel `commissionable_fare_cents BIGINT`, `non_commissionable_total_cents BIGINT`, `total_amount_cents BIGINT` columns. The legacy NUMERIC columns still exist for backward-compat dual-write; new code writes to `*_cents`.
- **Action for spec update:** §12.4 schema block should either drop the NUMERIC columns (preferred — matches §14.0.1 doctrine) or document the dual-write transition and the eventual NUMERIC-drop migration.

### §14.12 platform_revenue — `tier_rate_applied NUMERIC(5,2)` contradicts §14.0.2
- **Spec §14.12:** `tier_rate_applied NUMERIC(5,2)`.
- **Spec §14.0.2:** "Rates and percentages are stored as `NUMERIC(5,4)`."
- **Migration `20260525000000_money_columns.sql:73`:** `tier_rate_applied NUMERIC(5,4)` — and the migration header comment explicitly calls out the spec deviation (it says §14.12 shows wrong precision).
- **Action for spec update:** §14.12 should read `NUMERIC(5,4)` to match §14.0.2 and the live schema.

### §4 feature matrix vs §1.5 — "Downline (sub-hosts)" contradicts strict two-level structure
- **Spec §4 feature matrix:** Row "Downline (sub-hosts) — Y unlimited" for Sub-Host Pro and Sub-Host Agency.
- **Spec §1.5:** "The platform supports a strictly two-level structure: the platform, and direct tenants… No tenant nests beneath another tenant. If a sub-host engages subcontractors to help operate their agency, those subcontractors are users inside the sub-host's tenant — not separate tenants on the platform."
- **Reality:** Grep for `downline`, `sub_host_of`, `parent_tenant`, `downstream_tenant` returns zero matches in code or migrations. The platform genuinely has no tenant-nesting concept.
- **Resolution direction:** §1.5 is the correct statement. The §4 matrix row likely meant "subcontractors" (per §3.4a — the sub-host-internal subcontractor tracking feature) but used the misleading word "downline" which connotes MLM-style hierarchy.
- **Action for spec update:** §4 — either delete the "Downline (sub-hosts)" row entirely OR rename it to "Subcontractor tracking (internal, sub-host only)" with rate matching the §3.4a feature.

### §19.10 — reality-delta-supplement.md's "MISSING" claim is a misread
- **Supplement says:** §19.10 forum read-only mode is MISSING; spec requires auto-closure when sailing date passes.
- **Actual spec §19.10:** "Forum stays fully active for in-trip and post-trip conversation. Coordinator can post updates, photos, post-trip thanks. AI screening continues. **No automatic forum closure** — coordinator can manually lock when group has run its course."
- **Resolution:** The supplement misread §19.10. The spec doesn't require auto-closure. The actual real gap is §18.10 (group details / RSVP / member management become read-only on travel_start_date — which IS unenforced in code; see supplement-2 entry).
- **Action:** Annotate the §19.10 entry in `reality-delta-supplement.md` as "not actually a gap; spec was misread — see reality-delta.md §12." The real gap is the §18.10 one tracked in supplement-2.

### §32.13.2 — wording inconsistency on screenshot PII initial mode
- **Spec §32.13.2:** "Optional vision-based PII detection before issue attachment — initial behavior: warn the user, do not block."
- **Spec §32.15.1 (Phased Rollout):** "Phase 3: … Vision-based screenshot PII detection moves from warn to block if calibration supports it."
- **Reality:** Reality-delta §1 documents the whole detector as cost-deferred (stub returns `{ detected: false }`). So even the "warn" mode is dead because there's nothing to warn about.
- **Action for spec update:** Both §32.13.2 and §32.15.1 should add a status callout noting the detector itself is stubbed; warn-mode is functionally inactive. See reality-delta.md §1.

---

# Appended 2026-05-27 — operator decisions on punch-list items

Two punch-list items (P2 #17, P2 #18) were resolved by operator decision as spec edits rather than engineering work. Recording them here so the next spec-sync pass applies them; both are pure spec-text changes.

---

## §4 feature matrix — rename "Downline (sub-hosts)" row to "Subcontractor tracking"
- **Spec said:** §4 feature matrix lists `Downline (sub-hosts) — Y unlimited` for Sub-Host Pro and Sub-Host Agency.
- **Conflict:** §1.5 explicitly forbids tenant nesting ("strictly two-level structure… No tenant nests beneath another tenant"). Grep confirms zero downline-shaped code in the repo. The matrix row was likely a copy/paste from MLM-tier templates and never applied to this platform.
- **Operator decision (2026-05-27):** rename the row to `Subcontractor tracking (internal)` — the real sub-host-internal feature documented at §3.4a (which IS implemented per the `subcontractors` table + `(tenant)/settings/subcontractors/page.tsx`). The renamed row also clarifies that the feature is private bookkeeping inside one sub-host's tenant, not platform-managed.
- **Action for spec update:** §4 matrix — rename the row. Keep the Y/Y values for Sub-Host Pro and Sub-Host Agency (matches the existing UI gating which shows subcontractor tracking for tenant_type='sub_host' regardless of tier sub-level).

## §7.9 / §9.9 — strike "Last-Event-ID for reconnect" claim from SSE prose
- **Spec said:**
  - §7.9 "Streaming: chat uses Server-Sent Events (SSE) with Last-Event-ID for reconnect"
  - §9.9 "Reconnect supported via Last-Event-ID header"
- **Reality:** chat route streams SSE deltas via TransformStream but never emits `id:` lines per event and never reads the `Last-Event-ID` request header. EventSource's built-in connection-level auto-reconnect works, but server-side resumption from the last delivered event is NOT implemented. For LLM streams, server-side resumption is fundamentally hard (the model has already moved past that point in generation — the right answer is usually to start a fresh turn, not to resume from the middle).
- **Operator decision (2026-05-27):** strike from spec. EventSource browser-level auto-reconnect IS the actual contract.
- **Action for spec update:**
  - §7.9 conventions: change "SSE with Last-Event-ID for reconnect" to "SSE; EventSource browser-level auto-reconnect on connection drop. No application-level resumption — a drop mid-stream prompts the user to re-send."
  - §9.9: replace "Reconnect supported via Last-Event-ID header" with the same.

---

# Appended 2026-05-28 — F1/F2/F3 + P5 close-out + shift-left + Batches migration

Covers PRs #354–#363. Bigger updates that move spec text; small deviations land at the end as bullet points.

---

## §10.1a / §38.8.1 / §39.5 — supervisor IS now wired through token-gated chat

- **Spec said:** §10 supervisor "runs on every reply"; D-102 (memory) recorded a gap where token-gated chat surfaces (`/api/public/chat/[token]` for quote view + trip itinerary) shipped without supervisor.
- **Reality (since #357):** Full §10 pipeline now runs on token-gated chat. New tenant_context source kind `public_token_chat` + factory `tenantContextForPublicTokenChat`. New `conversations.public_access_token_hash TEXT` column (migration 20260627000008) with partial unique index on `(tenant_id, public_access_token_hash) WHERE NOT NULL`. Token is SHA-256-hashed before storage (raw token never persisted alongside the conversation).
- **Source:** PR #357, MEMORY D-104.
- **Action for spec update:** §10.1a footnote on supervisor coverage should drop the "deferred for token-only surfaces" note. §38.8.1 + §39.5 prose can describe the supervisor + regen-budget shape directly (was previously hedged).

## §9.6 — persona tools now dispatched; 3 real handlers + 3 honest placeholders

- **Spec said:** §9.6 lists 6 persona tools: `search_host_inventory`, `get_customer_context`, `generate_quote`, `collect_booking_details`, `escalate_to_human`, `update_memory`. Implied each tool runs end-to-end via Anthropic tool_use.
- **Reality (since #358):** Tool dispatcher + single-pass tool_use loop wired into `/api/chat` non-streaming branch. Three handlers are real: `escalate_to_human` (writes `escalation_topics`), `get_customer_context` (reads contact + recent bookings + customer_memories tenant-scoped), `update_memory` (writes `memory_extractions` queue with `status='pending_customer_review'` — `/settings/memory` is the §11.4 consent gate, NOT direct write to `customer_memories`). Three are honest placeholders returning structured `{ error: "not_implemented", can_fall_back_to: "escalate_to_human" }`: `search_host_inventory` (waits on BP14 adapter standardization), `generate_quote` (conflicts with §38 agent-owned pricing), `collect_booking_details` (conflicts with §20.4 on-page flow). Streaming-mode chat does NOT yet pass tools (F4 follow-up — buffering tool_use blocks across streamed deltas is materially harder).
- **Source:** PR #358, MEMORY D-105.
- **Action for spec update:** §9.6 should distinguish real handlers from placeholders, document the placeholder fallback contract, and note streaming-mode tool support is deferred.

## §20.2 — booking-flow customer UI: Stage 1 wired + confirmation page; Stages 2/3 placeholders

- **Spec said:** §20.2 platform-native fallback booking flow assumes 4 stages all wired.
- **Reality (since #359):** Stage 1 (Trip Details) is end-to-end — prefetches from `GET /api/bookings/[id]`, saves via PATCH, advances. New `/booking/confirmation/[id]` landing page Stage 4 was already redirecting to (pre-PR that target 404'd). Stages 2 (passengers) + 3 (options) remain form scaffolding without backing endpoints — `booking_passengers` CRUD + addons table are the missing surfaces.
- **Source:** PR #359; F8 follow-up tracks the remaining stages.
- **Action for spec update:** §20.2 should explicitly mark Stages 2/3 as scaffolding-only and reference the F8 follow-up. §20.4 booking-detail flow assumes the confirmation page exists — that's now true.

## §26.9 — vendor-health probe MUST NOT include Anthropic

- **Spec said:** §26.9 vendor-health probe pings each vendor's lightweight read endpoint every minute.
- **Reality (since #362):** Anthropic doesn't expose a free GET endpoint — `/v1/messages` is POST-only, so the pre-fix probe sent `GET /v1/messages` every minute and got HTTP 405 every time (1,440 wasted requests/day against the per-minute rate limit, with no useful signal). #362 removes Anthropic from the probe list. Vendor-health for Anthropic still works because every real `instrumentedClaudeCall` / `instrumentedClaudeStream` records `recordVendorSuccess` / `recordVendorFailure`.
- **Source:** PR #362.
- **Action for spec update:** §26.9 should call out that Anthropic is intentionally NOT in the probe list (the call-wrapper records vendor health on real traffic). Note the condition for adding it back: Anthropic exposes a cheap GET endpoint (e.g., `/v1/models` for org-tier keys).

## §27.12 — Anthropic Message Batches pipeline shipped

- **Spec said:** §27.12 covers AI cost attribution but does not describe a batch-API pathway. Real-time `instrumentedClaudeCall` is the only documented surface.
- **Reality (since #363):** New batch pipeline. Two tables (migration `20260528000000_ai_batches.sql`):
  - **`ai_batch_requests`** — 1 row per unit of work. `tenant_id`, `purpose` (one of `precruise_generation` / `memory_extraction` / `persona_addendum_screen` / `rag_pii_redaction` / `rag_normalization`), `status` (pending → submitted → completed|failed), `request_params` (JSONB — Anthropic message-create payload), `caller_metadata` (JSONB — producer's downstream context), `result_text` / `result_metadata` / `cost_cents` on completion.
  - **`ai_batch_jobs`** — 1 row per submitted Anthropic batch. `anthropic_batch_id`, `request_count`, `status`, totals.

  Service-role-only RLS; never read by user JWTs.

  New library at `apps/main/src/lib/ai/batch/{enqueue,flush,reconcile,types}.ts` + new public surfaces in `call-wrapper.ts` (`submitAnthropicBatch`, `getAnthropicBatchStatus`, `getAnthropicBatchResults`, plus `logAndIncrement` now exported so the reconciler writes the same `ai_call_log` + `tenant_usage_metrics` shape per row).

  Three new Inngest crons: `ai-batch-reconcile` (every 5 min, concurrency 1), `ai-batch-flush-precruise` (daily 9:30 UTC), `ai-batch-flush-memory-extraction` (hourly).

  Pre-cruise migration: scheduler split into `pre-cruise-email-scheduler-t1` (hourly + direct) and `pre-cruise-email-scheduler-multiphase` (daily 9:00 UTC + batched, ±12h window). Consumer `precruise-generate-and-send` is dual-path via `event.data.via` discriminator. New consumer `precruiseSendFromBatchResult` fires on `ai.batch_request.completed.precruise_generation`. Batched path folds 4-5 separate Haiku calls into 1 structured-JSON request (additional ~75% Anthropic round-trip reduction on top of the ~50% batch discount).

  Cost: T-7/T-30/T-90 emails ~50% cheaper at Haiku layer; T-1 unchanged.

- **Source:** PR #363; lays groundwork for F10–F12 (extract-memory, persona-addendum-screen, RAG ingest enrichment).
- **Action for spec update:** Add a new subsection §27.12.X "Async pipeline (Anthropic Batches)" describing:
  - The two-table model + their RLS posture
  - The `BatchablePurpose` whitelist + how to add a new one
  - Per-row cost attribution (same `ai_call_log` shape as real-time)
  - Dual-path producer/consumer pattern (Inngest events as the seam)
  - When to use batches (async, customer not waiting) vs real-time (chat, supervisor, agent co-pilot)

## §23.4 — pre-cruise scheduler is now TWO functions, not one

- **Spec said:** §23.4 implies a single hourly cron that checks all four T-N phases.
- **Reality (since #363):**
  - **`pre-cruise-email-scheduler-t1`** — hourly, ±1h window, T-1 only, fires `precruise/email.due { via: "direct" }`.
  - **`pre-cruise-email-scheduler-multiphase`** — daily 9:00 UTC, ±12h window, T-7/T-30/T-90, fires `precruise/email.due { via: "batched" }`.
- **Source:** PR #363.
- **Action for spec update:** §23.4 schedule prose should describe the split. Cadence table should show T-1 hourly + T-7/30/90 daily.

## §5.4.4 — atc/no-direct-service-role-import error message now self-healing

- **Spec said:** §5.4.4 forbids importing `service-role-client.ts` outside `tenant-client.ts` and `platform-admin-client.ts`; allowlist exceptions live in `packages/config/eslint-rules/no-direct-service-role-import.js`.
- **Reality (since #361):** Same rule, same allowlist. The error message now derives the exact path suffix the developer needs to add and embeds it in the violation:
  > "If this route MUST use service-role, add this path suffix to ALLOWED_PATH_SUFFIXES in packages/config/eslint-rules/no-direct-service-role-import.js, with a // comment naming the spec section that justifies it: `"/app/api/foo/route.ts"`,"
- **Source:** PR #361.
- **Action for spec update:** §5.4.4 prose can mention that the rule self-suggests the allowlist entry.

## Build / dev infrastructure (no spec impact)

These don't change spec text — recorded so a future spec-sync pass knows they're intentional:

- **`.claude/settings.json` is now committed** (was gitignored); `.claude/settings.local.json` is the per-user override path. The shared file wires three hooks: `block-spec-memory-edits.mjs` (PreToolUse), `lint-changed-file.mjs` (PostToolUse), `typecheck-changed-workspaces.mjs` + `run-affected-tests.mjs` (Stop).
- **New `pnpm verify` (full) + `pnpm verify:fast` (typecheck + lint) scripts** in root `package.json`. Pre-PR self-review checklist in `docs/runbooks/pr-self-review.md`.
- **`.nvmrc` carved out** to `24`; all 5 workflows read `node-version-file: ".nvmrc"` (PR #353). Fixes Node 20 deprecation warnings.

## Persona ↔ backstory alignment verified (no spec impact)

- **Source:** PR #356.
- **What:** The 6 travel personas (`apps/main/src/lib/personas/base-blocks/{marcus,marco,priya,dave,maya,jenny}.ts`) verified faithful to `specs/TechSpec/agent-backstories-photo-guide.md` (mammoth-converted from `Review/specs/Agent Backstories Photo Guide v2.docx`). Report at `docs/specs/persona-backstory-alignment-report.md`. No persona edits needed.
