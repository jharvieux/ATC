# Build Prompts — Spec v6.2, Part 6 (continued)

**This file contains Build Prompt 26 only.** Prompt 25 was in the prior file; Prompts 27 and 28 follow in separate files. The intro material in the Prompt 25 file applies here too.

-----

# BUILD PROMPT 26 — Four-layer auth reconciled, service-role discipline, forensics access controls

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** The §26.3a service-role discipline is the most important automated discipline in the platform. The CI lint rule must be HARD (red = no merge), not advisory. A single bypass — even one engineer overriding to ship a hotfix — establishes precedent that erodes the discipline. The four authorized service-role contexts (`tenantClient`, `platformAdminClient`, migrations, backup tooling) are exhaustive; anything else is a forbidden pattern. The per-job audit pattern with partial GIN index on `audit_log.changes` is a non-obvious schema decision with a hot-path performance implication — get the partial-WHERE wrong and user-action writes (which dominate write throughput) pay the GIN write cost. The §26.5a forensics_log key separation (already provisioned in Prompt 25 with `FORENSICS_ENCRYPTION_KEY_CURRENT`) is a blast-radius decision that matters on compromise — but the read-path access controls are what determine whether the log is actually privacy-protective in operation. Each of these is the kind of choice that, when wrong, only shows up in incidents.

**Spec references:** Part 6 §26.1 (threat model), §26.2 (four-layer auth — canonical model), §26.3 (assertPermission contract + sensitive-action re-auth), §26.3a (service-role discipline — four authorized contexts, forbidden patterns, platformAdminClient with withPlatformAdminAudit, per-job audit, partial GIN index, Inngest + webhook context factories), §26.4 (encryption — separate keys per use), §26.5 (audit_log canonical schema), §26.5a (forensics_log — schema, encryption, access controls, retention, legal_hold — table created in Prompt 25; access controls and retention land here), §26.6 (monitoring & alerts), §26.7 (incident response), §26.8 (anti-prompt-injection — verification only; mostly implemented in earlier prompts), §26.9 (vendor outage handling), §26.10 (breach response process — runbook shipped in Prompt 25), §26.13 (real PII on staging — documented risk acceptance). Depends on Part 3 Prompt 14 (`APP_ENCRYPTION_KEY_*` framework), Part 4 Prompt 19 (sensitive-routes list), Build Prompt 25 (forensics_log table + capture function).

**Prerequisite check:** Build Prompts 01–25 are committed. The `forensics_log` table exists from Prompt 25. `FORENSICS_ENCRYPTION_KEY_CURRENT` is provisioned and offsite-backed up per Part 3 Prompt 14 conventions.

**Goal:** Reconcile the four-layer auth and `assertPermission()` to the §26.2 / §26.3 canonical model — if earlier prompts diverged from spec, this is the converge point. Build the §26.3a service-role discipline as CI-enforced lint rules with hard-fail. Finalize the per-job audit pattern (`withPlatformAdminAudit`) and add the partial GIN index. Land the forensics_log access controls + decryption path + retention cron + legal-hold helper. Verify the §26.8 anti-prompt-injection controls. Build the §26.6 monitoring & alerts plumbing. Ship the §26.7 incident response runbook and the §26.9 vendor outage degraded-mode hooks.

**Tasks:**

1. **Audit existing `assertPermission` implementation.** Open `apps/main/src/lib/auth/assert-permission.ts` (or wherever it lives from Part 1/3 prompts). Compare against §26.3 step-by-step. If divergences exist:
- List them in MEMORY.
- Reconcile to the spec WITHOUT changing call-site signatures unless absolutely required. The returned shape per §26.3 is `{ ctx: TenantContext, user: { id, email, roles }, permissions: { allowed: true, expires_at: Date } }`. If the existing return shape differs, ADD the new fields rather than break existing callers; mark the older fields `// @deprecated — use ctx instead`.
- Add the `auth_time` claim freshness check for sensitive actions per §26.3 sensitive-action re-auth. Read the Supabase Auth JWT’s `auth_time` claim; compare to `NOW() - 4 hours`. If stale: throw a structured 401 with `{ error: 'reauth_required', return_to: req.url }` so the client can redirect to `/auth/reauth?return=...`.
1. **Sensitive-action allowlist — §26.3 + §17.7.** Maintain `apps/main/src/lib/auth/sensitive-actions.ts`:
- Allowlist of `(resource, action)` pairs that require <4h re-auth: commission overrides, role changes, ICA acceptance, custom-domain binding, persona-addendum publish, platform-admin queue operations, deny-list updates, tenant termination, billing changes, payout schedule changes, encryption key operations.
- `assertPermission` (Task 1) checks against this allowlist using the action’s `resource` + `action` pair. If the action is in the allowlist AND `auth_time` is stale: throw `reauth_required`.
- Document additions to this allowlist as MEMORY entries.
1. **Document the four-layer auth model.** `docs/architecture/four-layer-auth.md`:
- Render the §26.2 diagram in Markdown (textual equivalent — Layer 1 Identity, Layer 2 Tenant context, Layer 3 Authorization, Layer 4 Data access scoping).
- Explain each layer’s purpose and what fails open if skipped.
- Note that non-HTTP contexts (Inngest, webhooks) replace Layers 1+2 with the appropriate TenantContext factory per §5.4.5 — they don’t skip the layers; they substitute different sources for the same context.
- Link to the relevant code files: `assertPermission`, `tenantClient`, `platformAdminClient`, the Inngest/webhook context factories.
1. **Service-role discipline — CI lint rules.** Create or extend `apps/main/eslint-plugin-service-role/index.js`:
- **Rule 1: `no-service-role-outside-factories`.** Flag any source file (other than `apps/main/src/lib/db/tenant-client.ts` and `apps/main/src/lib/db/platform-admin-client.ts`) that imports `createServiceRoleClient` from `@supabase/supabase-js` (or the project’s wrapper).
- **Rule 2: `no-direct-service-role-env-import`.** Flag any import of `SUPABASE_SERVICE_ROLE_KEY` outside the two allowed factory files. The env var is read once, in those factories.
- **Rule 3: `no-ad-hoc-tenant-id-string`.** Flag function signatures of the shape `function X(tenant_id: string, ...)` that also construct database queries in the same function body. The replacement is `function X(ctx: TenantContext, ...)` using `tenantClient(ctx)`. This rule is heuristic — false positives can be silenced with `// eslint-disable-next-line no-ad-hoc-tenant-id-string` AND appending an entry to `docs/exceptions-service-role.md` table (date, file, reason, reviewer).
- **Rule 4: `no-direct-anthropic-or-openai-import`.** Flag direct imports of `@anthropic-ai/sdk` and `openai` outside `apps/main/src/lib/ai/call-wrapper.ts` (this file lands in Prompt 27 but the lint rule is added here so Prompt 27 has a clean lint check ready). For now, if `apps/main/src/lib/ai/call-wrapper.ts` doesn’t exist yet, the rule is registered but the allowed-path is `apps/main/src/lib/ai/**` (any file under that path) — Prompt 27 will tighten to the specific file.
- Register the plugin in `apps/main/.eslintrc` as part of `pnpm lint`. The `lint` script MUST fail on any of these rules — they’re errors, not warnings. Document this in `package.json` script comments.
- **Documented exception flow:** when a rule fires legitimately (rare), the engineer adds the disable comment AND appends to `docs/exceptions-service-role.md`. Quarterly review of this table by platform-super-admin per §26.11.
1. **Reconcile `platformAdminClient` + `withPlatformAdminAudit`.** Open `apps/main/src/lib/db/platform-admin-client.ts` and the `withPlatformAdminAudit` helper (from Part 3 Prompt 14 or Part 4 Prompt 16). Reconcile against §26.3a.3:
- The factory is `platformAdminClient()` — no parameters. It MUST throw if called outside `withPlatformAdminAudit`. Implementation pattern: store the active audit context in `AsyncLocalStorage`; `platformAdminClient()` reads from ALS and throws if absent.
- `withPlatformAdminAudit({ admin_user_id, reason, operation }, async (db, recordQuery) => { ... })`:
  - Inserts an `audit_log` row at entry with `actor_type = 'admin'`, `action = 'platformAdmin.{reason}'`, `tenant_id = null`, `changes` starting as `{ queries: [] }`.
  - Stores the audit row id in the ALS context.
  - Provides `db` (the platformAdminClient) and `recordQuery({ op, table, columns, row_count })` callback that appends to a queries array.
  - On wrapped function return: UPDATE the audit row with `outcome = 'success'`, `duration_ms`, the accumulated queries.
  - On wrapped function throw: UPDATE the audit row with `outcome = 'error_thrown'`, the error message (sanitized — strip PII), and any queries that completed before the throw. The audit row write is **outside the wrapped function’s transaction** — even on rollback, the audit row commits. Per §26.3a.3 “The audit row write is outside the wrapped function’s transaction.”
  - **Nesting detection:** if a `withPlatformAdminAudit` call is detected inside another `withPlatformAdminAudit` (via ALS lookup), the inner one is a no-op — the outer captures everything. Per §26.3a.3 “What ‘one job’ means.”
1. **Partial GIN index on audit_log.changes for admin rows.** Migration `apps/main/supabase/migrations/0027_audit_partial_gin.sql`:
   
   ```sql
   CREATE INDEX IF NOT EXISTS audit_log_changes_admin_gin_idx
     ON public.audit_log
     USING GIN (changes jsonb_path_ops)
     WHERE actor_type = 'admin';
   ```
- The partial-WHERE clause is critical per §26.3a.3 — user-action writes (the hot path) must NOT pay the GIN write cost.
- If the existing audit_log schema doesn’t have `actor_type` exactly matching the CHECK in §26.5, this migration also reconciles it: `ALTER TABLE audit_log` to add/extend the CHECK to include `('user', 'admin', 'system', 'api_client')`. Existing rows backfilled per their context (audit-log rows from prior prompts written via user paths get `'user'`, etc. — operator may need a one-off UPDATE statement; document in MEMORY).
1. **Inngest event registry + validator — §26.3a.4.** Build `apps/main/src/lib/inngest/event-registry.ts`:
- Static registry typed as `Record<string, { kind: 'tenant_scoped' | 'platform_admin'; payload_shape: ZodSchema }>`.
- Every Inngest event TYPE used in the project MUST be in the registry. Walk through the prior prompts and seed entries — the spec-emitted events include (non-exhaustive): `tenant.activated`, `tenant.suspended`, `tenant.terminated`, `tenant.submitted_for_review`, `tenant.subscription_changed`, `forum.message_needs_moderation_retry`, `rag.submission_needs_extraction`, `rag.submission_ready_for_pii_redaction`, `rag.submission_ready_for_normalization`, `tenant.rag_pii_recurring_pattern_detected`, `chat.anonymous_chat_burst_detected`, `quote.sent`, `commission.state_changed`, etc. The full list comes from auditing the codebase — document the audit in MEMORY.
- Build `validateInngestEvent(name, payload): asserts payload matches registry shape`. Called at the start of every Inngest function handler.
- **Lint rule** (extension of the service-role plugin): any `inngest.send({ name: 'foo.bar', ... })` call must reference an event present in the registry. The check is heuristic (string literal match against registry keys); document the limitation.
- Tenant-scoped events: the validator asserts `payload.tenant_id` is present.
- Platform-admin events: the consuming function MUST be wrapped in `withPlatformAdminAudit`. Verify this in the handler entrypoint with a runtime assertion (the ALS check from Task 5 throws if `platformAdminClient` is called outside the wrapper).
1. **Webhook context factories — §26.3a.4.** Build `apps/main/src/lib/auth/webhook-contexts.ts`:
- `tenantContextFromStripeEvent(event): Promise<TenantContext>` — looks up the tenant from `event.account` (Connect events) or `event.data.object.customer` (Subscription events) via the existing `stripe_account_id` or `stripe_customer_id` columns on `tenants`. Throws `WebhookContextNotFoundError` if not found.
- `tenantContextFromResendEvent(event): Promise<TenantContext>` — looks up by `email_log.resend_message_id = event.data.email_id` to derive `tenant_id`. Throws if not found.
- `tenantContextFromInngestEvent(event): TenantContext` — already in place from Part 3 Prompt 11; verify and reconcile.
- Each factory writes to `audit_log` with `action = 'webhook.context_resolved'`, `resource_type = 'webhook'`, `resource_id = event.id`, `changes = { event_type, resolved_tenant_id }`. Cross-tenant fishing via spoofed webhooks is detectable in audit.
- If a webhook event resolves to a `tenant_id` that does NOT match the `customer` or `account` field shape expected for that event type, throw `WebhookContextMismatch` (defense-in-depth — a malformed webhook should fail loud).
1. **Forensics access controls — finalize §26.5a.** Build `apps/main/src/lib/forensics/decrypt.ts`:
- `decryptForensicsSnapshot(snapshot_id: string): Promise<{ payload: unknown, metadata: { snapshot_type, reason, captured_at, captured_by_user_id } }>` — wrapped in `withPlatformAdminAudit` with `reason = 'forensics_log_review'`.
- Behavior:
  - Look up the row by `snapshot_id`.
  - Read `encryption_key_id`. If `'forensics-v1'`, use `FORENSICS_ENCRYPTION_KEY_CURRENT`. If a prior version (`'forensics-v0'`, etc.), use the matching `FORENSICS_ENCRYPTION_KEY_PRIOR_N`. If no matching key is loaded: throw `ForensicsKeyMissingError` and DO NOT update access counters.
  - On successful decrypt: increment `forensics_log.access_count`, update `last_accessed_at = NOW()`.
  - Return the payload and metadata to the caller.
- **NEVER callable outside the `withPlatformAdminAudit` wrapper** — the `platformAdminClient()` ALS check enforces this.
- The function does NOT log the decrypted payload anywhere — not to Sentry, not to console, not to any log. The caller is responsible for handling the payload safely (the runbook covers this).
1. **Forensics legal-hold helper.** Build `apps/main/src/lib/forensics/legal-hold.ts`:
- `setLegalHold(snapshot_id: string, hold: boolean, reason: string): Promise<void>` — wrapped in `withPlatformAdminAudit` with `reason = 'forensics_legal_hold_change'`.
- Sets `forensics_log.legal_hold` column.
- The `reason` parameter is captured in `audit_log.changes` so the legal basis for the hold is recorded.
1. **Forensics retention cron — §26.5a.** Inngest scheduled function `forensics-log-purge-cron` running daily at 03:00 UTC:
- `DELETE FROM forensics_log WHERE purge_after < NOW() AND legal_hold = FALSE`.
- The corresponding `audit_log` row pointing at the deleted forensics entry simply has a dangling `forensics_log_id` reference. Per §26.5a “Audit log retention (7 years per §26.5) is unaffected.” No cascading cleanup.
- Wrapped in `withPlatformAdminAudit` with `reason = 'forensics_retention_purge'`; the audit row records the count purged.
1. **Forensics capture invocation points — finalize.** Verify or wire `captureForensicsSnapshot` (from Prompt 25) to the spec’s five trigger points per §26.5a “What gets captured”:
- **Dispute creation (auto):** when `commissions.dispute_state` or `bookings.dispute_state` transitions to `'open'`. Snapshot includes the disputed row, underlying booking, host-adapter response, relevant audit_log entries from last 90 days for the related tenant + booking + customer, conversation messages where commission rate was discussed if applicable. `snapshot_type = 'commission_dispute'` or `'booking_dispute'`. The transition handler from Part 3 Prompt 15 (commission lifecycle) calls `captureForensicsSnapshot` synchronously before persisting the dispute state.
- **Tenant complaint submission:** when a tenant submits a complaint via the existing complaint surface. If no complaint surface exists from earlier prompts, build a stub at `POST /api/admin/complaints/new` that accepts `{ tenant_id, subject, body }` from the tenant_admin role and writes to a `complaints` table (created here: `id UUID PK, tenant_id, subject, body, submitted_by_user_id, submitted_at, status CHECK IN ('open','in_review','resolved'), resolved_at`). On insert: `captureForensicsSnapshot` with `snapshot_type = 'tenant_complaint'`, payload = recent audit log + relevant conversations + the complaint text.
- **Manual platform-admin trigger:** `POST /api/admin/forensics/snapshot` with `{ tenant_id, reason, payload_query }`. The `payload_query` is a structured spec saying which tables to include and over what date range; reject any raw SQL. `snapshot_type = 'ai_misbehavior_investigation'` is the most common; allow `'security_incident'` too.
- **CCPA data export request:** when the user requests export per Part 4 Prompt 17. Opt-in per-tenant via `tenant_settings.forensics_on_export BOOLEAN DEFAULT FALSE`. If TRUE, the export job calls `captureForensicsSnapshot` with `snapshot_type = 'data_export_request'`, payload = what was exported.
- **Security incident declaration:** `POST /api/admin/security-incident/declare` with `{ severity, summary, affected_tenant_ids }`. Writes a `security_incidents` table row (created here) AND calls `captureForensicsSnapshot` with `snapshot_type = 'security_incident'`, payload = audit log around the incident window + system state.
1. **Forensics manual decryption runbook — §26.5a.** Ship `docs/runbooks/forensics-manual-access.md`:
- When manual decryption is appropriate (court order; signed engagement letter; documented internal investigation).
- The decryption command runs on an operator workstation with keys present, NOT from application code. Example command sketch (operator adapts to actual tooling):
  
  ```
  pnpm tsx scripts/forensics-decrypt.ts --snapshot-id=<uuid> --case-ref=<external-ref>
  ```
  
  The script uses the same `FORENSICS_ENCRYPTION_KEY_CURRENT` from the env (operator-controlled) but writes the decrypted output to a path NOT in source control.
- Sign-off checklist: who authorized, what case ref, what was decrypted, when, who reviewed.
- The accompanying audit step: `audit_log` row written manually with `action = 'forensics.manual_decryption'` and the case reference. The runbook instructs the operator to do this.
- The runbook explicitly forbids running the decryption command from CI or from the application.
1. **Encryption key separation verification — §26.4.** The boot-time check is already in Prompt 25 Task 1. Verify it’s still active:
- `FORENSICS_ENCRYPTION_KEY_CURRENT` loaded as separate env var.
- `keyManager` and `forensicsKeyManager` are distinct module instances.
- Boot-time assertion `FORENSICS_ENCRYPTION_KEY_CURRENT !== APP_ENCRYPTION_KEY_CURRENT` (or any APP_ENCRYPTION_KEY_PRIOR_N) — if equal, exit with security-violation message.
- Add a deeper check: `FORENSICS_ENCRYPTION_KEY_PRIOR_*` (if set) must also not collide with `APP_ENCRYPTION_KEY_*`.
1. **Monitoring & alerts plumbing — §26.6.** For each signal in the §26.6 table:
- **Auth failure spike:** Inngest scheduled function `auth-failure-monitor` running every 5 minutes. Reads Supabase Auth logs via the Management API (or, if not feasible, reads from a local `auth_attempts` table that the auth middleware populates — document choice). Threshold: 50 failures from one IP in 5 minutes; severity Medium.
- **Permission denied spike:** Inngest scheduled function `permission-denied-monitor` running every 5 minutes. Queries `audit_log WHERE action LIKE '%.permission_denied' AND created_at > NOW() - INTERVAL '5 minutes'`. Threshold: 20 in 5 minutes per user; severity Medium.
- **Cross-tenant RLS bypass attempt:** any `audit_log` row with `actor_type = 'system'` AND `changes->'rls_bypass_attempt' = 'true'` — severity Critical, immediate alert. (Adding this detection requires the RLS error handler to write a structured indicator — extend the existing error-handler middleware.)
- **AI cost surge:** integrated with Prompt 27’s per-call cost tracking. Cron runs hourly; threshold = current-day cost > 200% of 30-day average for any tenant; severity Medium. Build the consumer here as a stub that reads `ai_call_log` (table comes in Prompt 27 — until then the query returns empty and the stub no-ops).
- **Stripe webhook signature failure:** any webhook signature mismatch from the existing `/api/webhooks/stripe` handler logs an audit row with `action = 'webhook.signature_mismatch'`; severity High.
- **Adapter health degraded:** the Part 3 Prompt 14 adapter health cron’s output is the source. Consumed by an alert handler here.
- **Database connection pool exhaustion:** Supabase Pooler logs; integration via Sentry alert rule.
- **Error rate >1% sustained for 5+ minutes:** Sentry alert rule.
- **Page latency >2s p95:** Vercel Analytics alert rule.
- All alerts route to a single platform-admin notification channel (in-app via Part 5 Prompt 23 `notifications` + email + optional Slack webhook). Build `sendOperatorAlert({ severity, signal, detail })` that fans out.
1. **Incident response — §26.7.** Ship `docs/runbooks/incident-response.md` with the four-priority table from §26.7:
- **P0 — Active customer harm:** examples (a hate-speech AI response in production, a payment fraud confirmed). Page primary oncall + executive escalation; aim for first response <15 min, contain <1h.
- **P1 — Imminent customer harm or major business impact:** examples (cross-tenant data leak, sustained AI cost surge). Page primary oncall; first response <1h.
- **P2 — Degraded service:** examples (vendor outage, elevated error rate). Open incident; first response within next business hour.
- **P3 — Operational toil or low-impact bug:** queue for next-week triage.
- Per-priority playbook: who to page, where to declare in (e.g., a dedicated #incidents channel), when to declare a security incident (Task 12), when to engage legal counsel.
- Oncall rotation template (operator fills in).
1. **Vendor outage handling — §26.9.** Build degraded-mode hooks per the §26.9 table:
- **Anthropic down:** chat endpoint returns a fallback “Our AI is temporarily unavailable; please leave a message and we’ll be in touch.” Surface a small banner. Optional cache layer for common queries is deferred (`// TODO(cache)`); ship the fallback message path. Detection: HTTP 5xx from Anthropic 3 times in a row across separate requests.
- **OpenAI embeddings down:** new RAG submissions queue with retry (Inngest delayed jobs); existing retrievals (using pre-computed embeddings) work normally. Detection: HTTP 5xx from OpenAI embeddings.
- **Stripe down:** read paths continue (subscription state cached); write paths queue via Inngest with retry; tenants see a dashboard banner “Payment processing temporarily unavailable.” Detection: Stripe webhook delivery failures + API 5xx.
- **Resend down:** queue with retry (Inngest delayed jobs); in-app notifications continue normally. Detection: Resend API 5xx + webhook delivery failures.
- **Supabase down:** post status; nothing else the platform can do.
- Each degraded mode is detected by either an explicit health check OR by error patterns in the supervisor / handler layer. Build a shared `vendorHealthStatus` registry in memory (per-instance) that handlers read; an Inngest cron `vendor-health-probe` running every minute pings each vendor and updates the registry. The registry’s state surfaces as a `/admin/vendor-status` page for the operator.
1. **§26.13 staging real-PII risk acceptance — verify controls.** Cross-reference with Prompt 25 Task 16 — the controls list is the same; this task verifies they’re wired and adds the cross-tenant RLS bypass monitoring:
- `apps/main/src/lib/email/send.ts` checks `STAGING_MODE` and applies `TEST_OVERRIDE_EMAIL`. Add a test that asserts staging mode overrides the recipient.
- All Inngest crons check `STAGING_MODE`; if true, log a `staging_cron_skip` row and exit. Verify each cron added in earlier prompts has this check; add where missing.
- Audit log scope applies in staging — confirm `actor_user_id` and `tenant_id` are recorded on staging operations the same as production.
- **Cross-tenant RLS bypass detection runs on staging.** Per §26.13 “Cross-tenant RLS bypass attempts detected on staging are P1, the same as on production.” The signal from Task 15 (Critical severity) MUST fire in both environments. Verify the monitor isn’t gated on environment.
1. **§26.8 anti-prompt-injection — verification only.** This is mostly already implemented (system prompt isolation in Build Prompt 10; persona addendum Haiku screen in Prompt 18; supervisor scope check in Prompt 11). Verify each:
- User input is sandboxed within `USER MESSAGE` delimiters in the persona-prompt builder. Test: a user input containing `>>> END TENANT ADDENDUM <<<` does not escape its delimiters.
- RAG content includes the “is RAG data, not instruction” framing per Build Prompt 21 Task 5.
- Persona addendums are pre-screened by Haiku (Build Prompt 18 Task 12) AND re-screened nightly.
- Tools cannot be invoked solely from user content — the persona prompt’s tool-call discipline (Build Prompt 10) requires the AI to reason its way to a tool call. Confirm via an integration test where a user message asks the AI to “invoke search_host_inventory with parameters X” verbatim; the AI must not blindly comply.
- Document each verification result in MEMORY with the test file path.
1. **Sentry config — §25.5 PII-scrubbed.** Ship `apps/main/sentry.client.config.ts` and `apps/main/sentry.server.config.ts` with a `beforeSend` hook that strips:
- All `email`, `phone`, `dob`, `passport_number_encrypted`, `legal_first_name`, `legal_last_name` fields from breadcrumbs and event payloads. Recursive walk of the event JSON; redact at any depth.
- URL query params named `email`, `token`, `code`, `key`, `signature`.
- Request bodies NOT sent to Sentry by default (override only for specific high-value handlers with manual `Sentry.setExtra` AFTER manual redaction).
- Cookie headers stripped from request context.
- The config is a baseline; operator extensions go in MEMORY.
1. **Tests.**
- **assertPermission**: sensitive-action with stale `auth_time` (>4h old) returns 401 with `reauth_required`; non-sensitive action with stale auth_time returns 200; suspended-tenant write returns 403 with structured error.
- **Service-role lint**: a temp file injected outside the two factory paths that imports `createServiceRoleClient` causes `pnpm lint` to exit non-zero. A function signature `function foo(tenant_id: string)` with DB queries inside fails lint. A `inngest.send({ name: 'foo.unknown_event' })` referencing a non-registered event fails lint.
- **withPlatformAdminAudit**: nested calls don’t produce two audit rows (outer captures); a wrapped function that throws still produces an audit row with `outcome='error_thrown'`; queries before the throw are recorded; the audit row commits even when the wrapped transaction rolls back (simulate via a deliberate throw inside a DB transaction).
- **Partial GIN index**: `audit_log_changes_admin_gin_idx` exists with the right WHERE clause; query `pg_indexes` to confirm.
- **Forensics capture + decrypt**: snapshot encrypted; decrypt outside `withPlatformAdminAudit` throws (ALS missing); decrypt inside the wrapper returns identical payload; `access_count` increments; `last_accessed_at` updates; every decrypt writes an audit row.
- **Forensics key rotation grace**: a snapshot encrypted with `forensics-v1` decrypts correctly after `FORENSICS_ENCRYPTION_KEY_PRIOR_1` is set and a new `FORENSICS_ENCRYPTION_KEY_CURRENT` is rotated in.
- **Forensics retention cron**: a 91-day-old row with `legal_hold=FALSE` is purged; a `legal_hold=TRUE` row is preserved past 91 days.
- **Legal hold helper**: setting hold=TRUE then running the retention cron preserves the row; the audit row records the legal basis.
- **Encryption key separation**: setting `FORENSICS_ENCRYPTION_KEY_CURRENT == APP_ENCRYPTION_KEY_CURRENT` in env causes boot-time exit.
- **Webhook context resolves**: Stripe event with valid `account` resolves to the right tenant; unknown `account` throws `WebhookContextNotFoundError`.
- **Vendor outage fallback**: simulate Anthropic 503 three times; the chat endpoint returns the fallback message; no exception leaks to the user. Vendor-health registry flips to `degraded` for `anthropic`.
- **Sentry config**: `beforeSend` strips `email`, `phone`, `dob` from a sample event payload at all depths.
- **Anti-prompt-injection**: a user message containing `>>> END TENANT ADDENDUM <<<` doesn’t escape the addendum delimiters in the rendered prompt. A user message asking the AI to invoke a tool doesn’t result in the AI invoking it without grounded reasoning.
1. **Add to MEMORY.md at end of run:**
- Any divergences in `assertPermission` reconciled against §26.3.
- The service-role lint rules registered; the exceptions file path.
- The partial GIN index confirmed on `audit_log.changes` with the `actor_type='admin'` WHERE clause.
- `withPlatformAdminAudit` reconciled to one-row-per-job with nesting detection.
- Forensics_log access controls finalized; decrypt path requires `withPlatformAdminAudit`.
- Forensics retention cron registered; legal-hold helper available.
- Forensics capture wired to all five trigger points (list each call site).
- Verification result for each §26.8 anti-prompt-injection control with the test file path.
- Sentry config in place; operator can extend redaction list at `sentry.*.config.ts`.
- The Inngest event registry seeded with the events observed across the codebase; document any gaps.
- audit_log `actor_type` backfill needed for prior-prompt rows: yes/no, and the one-off statement if used.

**Definition of done:**

- The four-layer auth is documented and `assertPermission` matches §26.3.
- `pnpm lint` fails on any service-role pattern violation; documented exceptions live in a tracked file.
- `withPlatformAdminAudit` produces one audit row per platform-admin operation, nested-call-aware, error-path-aware, transaction-rollback-safe.
- The partial GIN index on `audit_log.changes` exists with the `actor_type='admin'` WHERE clause.
- Forensics_log access controls are live: decrypt requires `withPlatformAdminAudit`; legal-hold helper available; retention cron runs daily; key-rotation grace works.
- `FORENSICS_ENCRYPTION_KEY_CURRENT` is verified separate from credentials keys at boot.
- Webhook context factories resolve correctly and audit-log every resolution.
- Vendor outage fallbacks render correctly in degraded mode; vendor-health registry surfaces in `/admin/vendor-status`.
- §26.13 staging controls verified or wired, including cross-tenant RLS bypass monitoring on staging.
- Sentry config strips PII from events.
- Incident response runbook in place.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:migrations` all pass.

**After completion:** MEMORY.md entry per Task 22.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```