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
