# Build Prompts — Spec v6.2, Part 6 (Sections 25–27)

**This file contains Build Prompt 25 only.** Build Prompts 26, 27, and 28 are in separate files per the one-prompt-per-turn workflow chosen at session start. The intro material below applies to all four Part 6 prompts.

## Note on Part 8 §31 — Implementation Phasing

Part 8 of the spec (§31) is a planning document — it sequences Phase 1 (Prong 1 first-party operation) → Phase 2 (BYO and sub-host onboarding open) → Phase 3 (scale tuning) and lays out phasing philosophy (money path first, first-party before third-party, ship minimum that exposes design). It is **not a buildable section.** Several earlier build prompts already responded to its phasing (e.g., Part 4 Prompt 16’s “Phase 0/1 simplified, Phase 2 attorney gate” around §15.7 compliance). No build prompts exist for §31; it is operator-side sequencing guidance.

## How Part 6 builds on Parts 1–5

Part 6 takes the platform from “fully operating AI-mediated customer experience” (end of Part 5) to a **compliance-, security-, and cost-disciplined** platform. By the end of Part 6:

- The CCPA purge stub left in Part 4 Prompt 17 is now real. The §25.4a three-category free-text anonymization runs on customer deletion — chat message bodies are NULLed (Category 1), AI-generated narratives in `quotes.narrative` / `bookings.notes` / `customer_memories.notes_freeform` are NULLed (Category 2), tenant-authored CRM notes are retained with foreign-key references replaced by hash-derived placeholders (Category 3). Forensics-log snapshots run BEFORE the deletion when the customer has an active dispute.
- The §25.10 staging real-PII risk acceptance is finalized as a runbook and the controls listed there (outbound isolation wrappers, external-service neutering, background job suppression, access scope, refresh hygiene) are made real where they aren’t already.
- The §26.2 four-layer auth is documented as the canonical model; `assertPermission()` is reconciled with what earlier prompts produced. The §26.3a service-role discipline is enforced via hard-fail CI lint. The §26.5a forensics_log is live with a dedicated encryption key, 90-day default retention, and `legal_hold` extending indefinitely.
- The five-dimension SaaS abuse monitoring per §27 is live with AI cost limits sitting below subscription revenue (30 / 50 / 70 %), the RAG total-cap-with-promotion-rewards model, and monotonic state transitions within billing periods. Per-call AI cost attribution feeds the AI cost dimension.

All four Part 6 prompts assume Build Prompts 01–24 from Parts 1–5 are committed. Each prompt names the spec sections it depends on.

-----

## Prerequisites added by Part 6

### 1. New keys to generate before Build Prompt 25

```
PLATFORM_PEPPER (required, secret) — 256-bit random; used by customer-hash derivation
FORENSICS_ENCRYPTION_KEY_CURRENT (required, secret) — 256-bit base64 (used in Prompt 26)
FORENSICS_ENCRYPTION_KEY_PRIOR_1 (optional, secret) — for rotation grace
FORENSICS_ENCRYPTION_KEY_PRIOR_2 (optional, secret)
```

`FORENSICS_ENCRYPTION_KEY_*` MUST be different from the `APP_ENCRYPTION_KEY_*` series from Part 3 Prompt 14 (tenant credentials) per §26.5a “The encryption-key separation matters.” Same DR discipline applies: offsite backup, quarterly verification per Part 3 Prompt 14.

`PLATFORM_PEPPER` is set once at platform genesis and **never rotated** — a rotation breaks all existing customer hashes used by `bookings.anonymized_customer_hash`, `commissions.anonymized_customer_hash`, and the tenant CRM notes anonymization in Prompt 25.

### 2. Daily AI pricing cache

Per §27.12 — `cost_estimate_cents` is computed from the model’s posted pricing at the time of the call, cached daily. The cache itself is a JSON-typed file in source (`apps/main/src/lib/ai/pricing.ts`); the daily auto-refresh path is operator-maintained because pricing pages change format. Build Prompt 27 ships current values; auto-fetch parsers are `// TODO(operator)`.

### 3. Decisions to make before Build Prompt 25

- **Tenant breach notification template content.** The §25.9 SLA (tenant admins within 24h; users within 72h) is fixed; the email template wording must be drafted and reviewed by counsel before launch. Operator-side; not blocking code. The email-send paths exist.
- **Forensics review legal procedure.** §26.5a names “authorized legal counsel via documented access procedure (NOT programmatic — manual decryption with operator-controlled keys, paired with a court order or signed engagement letter).” This is a runbook deliverable, not code. Build Prompt 26 ships the runbook template at `docs/runbooks/forensics-manual-access.md`.

### 4. Open items the spec leaves to implementation

- **Sentry PII scrubbing config.** §25.5 sub-processor disclosure says “Sentry (error tracking, PII-scrubbed).” The PII scrubbing rule set must be configured per Sentry’s `beforeSend` hook. Build Prompt 26 ships a baseline; operator extends.
- **Cost attribution accuracy ceiling.** §27.12 explicitly says “good enough for monthly billing reconciliation, not chargeback to the cent.” Some shared overhead is amortized. Build Prompt 27 accepts the gap.

### 5. Spec-correction calls flagged for MEMORY

- Part 4 Prompt 17 stubbed `purgeUserDataPerRetention(userId)` with a `// TODO(part-6)` note. Build Prompt 25 (this prompt) implements it.
- Part 5 Prompts 22 and 24 emitted `rag_pii_recurring_pattern_detected` and `chat.anonymous_chat_burst_detected` events with `// TODO(part-6)` consumers. Build Prompts 27/28 implement those consumers as abuse signals feeding the admin dashboard “signals” surface (alert-only — they do NOT directly drive automated throttling at launch).
- Earlier prompts may have used ad-hoc audit-row shapes. Build Prompt 26 reconciles to the canonical §26.5 + §26.3a.3 shape.

-----

## How to use the build prompts below

Same as Parts 1–5. Each prompt is self-contained for Claude Code. **Three of the four Part 6 prompts call for Opus.** Part 6 IS the platform’s compliance/security/cost-control backbone — wrong-by-defaults are the most expensive class of bug. The cost of Opus is small relative to the cost of a CCPA violation, a forensic-investigation failure, or a tenant whose AI cost runs above their subscription revenue for a billing period.

-----

# BUILD PROMPT 25 — CCPA retention closeout, free-text anonymization, breach response

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** The §25.4a three-category free-text anonymization contract has compliance-binding edges. Category 1 (chat messages) is hard-delete of body text; Category 2 (AI-generated narratives in three named tables) is NULL of specific columns; Category 3 (tenant-authored CRM notes) is FK replacement with hash-derived placeholder while preserving the text. Confuse categories — say, NULL a tenant-authored note instead of replacing the FK, or anonymize an AI-narrative instead of NULLing — and the platform either loses tenant business records (lawsuit risk) or fails CCPA. The forensics-snapshot-before-deletion rule for active disputes is narrow: a customer mid-dispute deletes, the platform reconstructs from the snapshot. Getting the order wrong (delete then snapshot, or always-snapshot) is either a privacy violation or storage-prohibitive. The retention crons (7-year financial, 90-day retrieval logs, 60-day anonymous sessions, etc.) must each enforce the right rule; one mis-scoped DELETE is a compliance event.

**Spec references:** Part 6 §25.1 (data classifications), §25.2 (retention schedule), §25.3 (CCPA rights), §25.4 (anonymization of required-retention data — booking and commission records), §25.4a (free-text anonymization strategy — three categories + forensics snapshot before deletion), §25.5 (sub-processors disclosure), §25.6 (US-only data residency), §25.7 (consent granularity), §25.8 (cookie policy), §25.9 (data breach response SLAs), §25.10 (staging real-PII risk acceptance). Depends on Part 4 Prompt 17 (CCPA delete request flow with 30-day grace period — the `purgeUserDataPerRetention` stub is what this prompt fills in), Part 4 Prompt 18 (BrandedLayout email template — used for breach notification emails), Part 5 Prompt 23 (email send infrastructure).

**Prerequisite check:** Build Prompts 01–24 are committed. Part 4 Prompt 17 created the CCPA delete request flow with a stubbed `purgeUserDataPerRetention(userId)` and a 30-day grace period. `PLATFORM_PEPPER` and `FORENSICS_ENCRYPTION_KEY_CURRENT` env vars are provisioned.

**Goal:** Finalize the CCPA deletion path with the §25.4a three-category free-text anonymization. Implement all retention-schedule crons per §25.2. Build the forensics-snapshot-before-deletion path for active disputes (full forensics_log access controls land in Prompt 26 — this prompt creates the table and writes capture-only). Ship cookie policy plumbing per §25.8. Ship the data-breach-response runbook + notification email templates. Document the §25.10 staging-PII risk acceptance with the controls list verified end-to-end.

**Tasks:**

1. **Env vars.** Extend `apps/main/src/lib/env.ts`:
   
   ```
   PLATFORM_PEPPER (required, secret)
   FORENSICS_ENCRYPTION_KEY_CURRENT (required, secret)
   FORENSICS_ENCRYPTION_KEY_PRIOR_1 (optional)
   FORENSICS_ENCRYPTION_KEY_PRIOR_2 (optional)
   ```
   
   Boot-time check: assert `FORENSICS_ENCRYPTION_KEY_CURRENT !== APP_ENCRYPTION_KEY_CURRENT`. If equal, exit on boot with a security-violation message. Per §26.5a key-separation requirement.
1. **Schema: deletion grace markers, anonymization audit, forensics log.** Migration `apps/main/supabase/migrations/0026_retention.sql`:
- `public.ccpa_deletion_executions` — one row per executed purge: `id UUID PK`, `user_id UUID NOT NULL REFERENCES users(id)`, `tenant_id UUID REFERENCES tenants(id)` (nullable — platform-level user records exist), `grace_period_ended_at TIMESTAMPTZ NOT NULL`, `executed_at TIMESTAMPTZ DEFAULT NOW()`, `category_1_messages_nulled_count INTEGER NOT NULL DEFAULT 0`, `category_2_narratives_nulled_count INTEGER NOT NULL DEFAULT 0`, `category_2_memories_deleted_count INTEGER NOT NULL DEFAULT 0`, `category_3_notes_anonymized_count INTEGER NOT NULL DEFAULT 0`, `bookings_anonymized_count INTEGER NOT NULL DEFAULT 0`, `commissions_anonymized_count INTEGER NOT NULL DEFAULT 0`, `forensics_snapshot_id UUID`, `forensics_snapshot_reason TEXT`, `customer_hash TEXT NOT NULL`, `purge_outcome TEXT CHECK (purge_outcome IN ('success','partial_failure','error')) NOT NULL DEFAULT 'success'`, `error_detail TEXT`, `UNIQUE (user_id)`.
- `ALTER TABLE public.bookings ADD COLUMN anonymized_customer_hash TEXT, ADD COLUMN anonymized_at TIMESTAMPTZ`. Same on `public.commissions`. Per §25.4.
- **`public.forensics_log` table** per §26.5a — create here so Prompt 25 can capture into it; Prompt 26 will add the access-controlled decrypt path and the retention cron:
  - `id UUID PK`, `tenant_id UUID REFERENCES tenants(id)`, `audit_log_id UUID REFERENCES audit_log(id)`, `snapshot_type TEXT NOT NULL CHECK (snapshot_type IN ('commission_dispute','booking_dispute','tenant_complaint','ai_misbehavior_investigation','data_export_request','security_incident'))`, `reason TEXT NOT NULL`, `encrypted_payload BYTEA NOT NULL`, `encryption_key_id TEXT NOT NULL`, `redacted_summary JSONB`, `captured_by_user_id UUID REFERENCES users(id)`, `captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `purge_after TIMESTAMPTZ NOT NULL`, `legal_hold BOOLEAN NOT NULL DEFAULT FALSE`, `last_accessed_at TIMESTAMPTZ`, `access_count INTEGER NOT NULL DEFAULT 0`.
  - Indexes: `forensics_log_purge_idx` partial WHERE `legal_hold = FALSE`; `forensics_log_audit_link_idx` on `audit_log_id`.
  - RLS: no tenant-level access. Service-role-only on writes; reads only via the admin path (Prompt 26).
- Indexes for `ccpa_deletion_executions`: PK + UNIQUE on `user_id`. Index on `users (deleted_at, status)` partial WHERE `status = 'deleted'`.
1. **Customer-hash derivation.** Build `apps/main/src/lib/privacy/customer-hash.ts`:
- `deriveCustomerHash(user_id: string, tenant_id: string | null): string` returns `base64url(sha256(user_id + '|' + (tenant_id ?? 'PLATFORM') + '|' + PLATFORM_PEPPER))` truncated to 32 chars.
- The hash is **deterministic** for a given (user_id, tenant_id, pepper) — it MUST be, because the same hash needs to land in `bookings`, `commissions`, and `tenant_crm_notes` anonymization for the same customer.
- **Pepper rotation is a deliberate non-feature.** If the pepper rotates, old hashes don’t match new ones. Document in MEMORY: pepper is set once at platform genesis and never changes.
1. **Forensics capture function — partial (capture-only).** Build `apps/main/src/lib/forensics/capture.ts`:
- `captureForensicsSnapshot({ tenant_id, snapshot_type, reason, payload, audit_log_id, captured_by_user_id }): Promise<{ snapshot_id: string }>`:
  - JSON-serialize `payload`.
  - Encrypt with `FORENSICS_ENCRYPTION_KEY_CURRENT` (AES-256-GCM, per-record IV stored in ciphertext header). Reuse the AES-256-GCM helper from Part 3 Prompt 14 if it exists; otherwise build a minimal wrapper.
  - Generate `redacted_summary` JSONB — a minimal safe preview (snapshot_type, counts of items snapshotted, time range, the affected user_id and tenant_id). NO actual content.
  - Insert `forensics_log` row with `purge_after = NOW() + 90 days`, `encryption_key_id = 'forensics-v1'`.
  - Return `{ snapshot_id }`.
- **`decryptForensicsSnapshot` is NOT built in this prompt** — Prompt 26 owns it because it requires the `withPlatformAdminAudit` wrapper and access controls. Until Prompt 26 ships, the only writes to `forensics_log` are from this prompt’s deletion-path capture (Task 5 step 2).
1. **The `purgeUserDataPerRetention` function — closing the Part 4 stub.** Build `apps/main/src/lib/privacy/purge-user-data.ts`:
- **Signature:** `purgeUserDataPerRetention({ user_id, executed_at? }): Promise<PurgeResult>`. Returns counts per category.
- **Step 1 — Customer-hash computation.** `customer_hash = deriveCustomerHash(user_id, null)` (platform-level; for tenant-scoped resources the hash is still scoped to user since the spec ties the hash to the user, not per-tenant-per-user).
- **Step 2 — Forensics-snapshot-before-deletion check.** Query `commissions WHERE customer_user_id = $user_id AND dispute_state IN ('open','under_review')` and `bookings WHERE customer_user_id = $user_id AND dispute_state IN ('open','under_review')`. If any rows: call `captureForensicsSnapshot` with:
  - `snapshot_type = 'commission_dispute'` if any commission disputes, else `'booking_dispute'`.
  - `reason = 'ccpa_deletion_with_active_dispute'`.
  - `payload` = the disputed rows + underlying bookings + relevant audit_log entries (last 90 days for this user) + conversation messages where commission rate was discussed (if applicable).
  - Record the returned `snapshot_id` in `ccpa_deletion_executions.forensics_snapshot_id`.
  - If no disputes: skip; `forensics_snapshot_id` stays NULL.
- **Step 3 — Category 1: chat messages.** `UPDATE messages SET content = NULL, supervisor_findings = jsonb_set(COALESCE(supervisor_findings, '{}'::jsonb), '{pii_fields_nulled}', 'true') WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = $user_id)`. Per §25.4a Category 1: body removed; metadata stays (`id`, `conversation_id`, `sender_role`, `created_at`, token counts). The `supervisor_findings` JSONB has any PII fields within it nulled — the simplest approach is to set the whole JSONB to a placeholder per §25.4a “supervisor_findings JSONB (with any PII fields within it nulled separately).” Count the rows touched.
- **Step 4 — Category 2: AI-generated narratives in three named tables.**
  - `UPDATE quotes SET narrative = NULL WHERE customer_user_id = $user_id`. Count.
  - `UPDATE bookings SET notes = NULL WHERE customer_user_id = $user_id`. Count.
  - `DELETE FROM customer_memories WHERE user_id = $user_id`. Count. Per §25.4a “customer_memories row is hard-deleted entirely (the row exists to track customer state; if there’s no customer, there’s no row).”
- **Step 5 — Category 3: tenant-authored CRM notes.** The spec doesn’t name the CRM-notes table canonically. Inspect the schema for the column that looks like tenant-authored notes about a customer — likely `contacts.notes` or a separate `tenant_crm_notes` table. Adapt:
  - If a separate `tenant_crm_notes` table exists: `UPDATE tenant_crm_notes SET customer_user_id = NULL, customer_hash = $customer_hash WHERE customer_user_id = $user_id`.
  - If the notes are on `contacts.notes` and the FK is `contacts.user_id`: `UPDATE contacts SET user_id = NULL, anonymized_customer_hash = $customer_hash WHERE user_id = $user_id`. (Add the `anonymized_customer_hash` column to `contacts` if not present.)
  - The text body is RETAINED per §25.4a Category 3.
  - Document the actual table name and column path in MEMORY.
- **Step 6 — Booking/commission anonymization per §25.4.** For each `bookings` row with `customer_user_id = $user_id`:
  - `UPDATE bookings SET customer_user_id = NULL, anonymized_customer_hash = $customer_hash, anonymized_at = NOW(), customer_email = NULL, customer_phone = NULL, customer_dob = NULL WHERE customer_user_id = $user_id`.
  - (Adapt column names if denormalized PII columns are named differently — `lead_passenger_email` vs `customer_email`, etc. Document actual column names in MEMORY.)
  - Booking financial details retained (booking_total_cents, commission_amount_cents, etc.).
  - Same shape for `commissions`: `UPDATE commissions SET customer_user_id = NULL, anonymized_customer_hash = $customer_hash WHERE customer_user_id = $user_id`. Count.
- **Step 7 — `booking_passengers` (other passengers on this customer’s bookings).** Per §25.4 the platform retains the booking record including passenger details for the 7-year retention. Passenger DOBs are required for cruise-line history. **Do NOT delete passenger rows.** Their `contact_id` FKs may need similar anonymization handling if they’re also the deleting user — but per §25.4a Category 3 logic, since these are tenant-tracked entities, anonymize the FK and retain rest.
- **Step 8 — User record.** `UPDATE users SET email = NULL, phone = NULL, full_name = NULL, deleted_purged_at = NOW(), status = 'purged' WHERE id = $user_id`. Keep the row for FK integrity; mark it purged. Add the `deleted_purged_at TIMESTAMPTZ` and extend the `status` CHECK constraint to include `'purged'` if not already.
- **Step 9 — `legal_consents` retained.** Per §25.4 retention reasoning: the consent record is legal proof of a point-in-time acceptance; deleting it is self-inflicted compliance damage. No action.
- **Step 10 — Audit.** Insert `ccpa_deletion_executions` row with all counts and the forensics_snapshot_id (or NULL). Write `audit_log` row with `action = 'user.ccpa_purge_executed'`, `resource_type = 'user'`, `resource_id = user_id`, `changes` JSONB containing the counts.
- **Error handling:** wrap steps 3–9 in a single DB transaction. If any step fails: rollback, set `ccpa_deletion_executions.purge_outcome = 'error'`, write `error_detail`, alert platform admin, and re-raise. Forensics capture (step 2) is OUTSIDE the transaction — if forensics fails, the deletion does not proceed (return early with outcome=`error`).
1. **Anonymous session data cleanup — §25.2.** Inngest scheduled function `anonymous-session-cleanup` running daily at 04:00 UTC:
- `DELETE FROM anonymous_chat_counters WHERE last_seen_at < NOW() - INTERVAL '60 days'`. (The 7-day rule from Part 5 Prompt 24 covers internal cleanup; this 60-day rule is the privacy/GDPR-aligned outer bound from §25.2.)
- If a `anonymous_session_state` table exists from earlier prompts: same rule.
- Per §25.2 “Anonymous session data: 60 days. Cleanup of unattached data.”
1. **Retrieval logs aggregation — §25.2.** Inngest scheduled function `retrieval-logs-aggregate-and-purge` running daily at 05:00 UTC:
- Create `public.retrieval_logs_monthly_aggregates` if not present: `id UUID PK, tenant_id UUID, year_month TEXT (format YYYY-MM), persona_id UUID, chunk_id UUID, retrieval_count INTEGER, feedback_positive INTEGER, feedback_negative INTEGER, UNIQUE (tenant_id, year_month, persona_id, chunk_id)`.
- For each detailed `retrieval_log` row older than 90 days: UPSERT into the monthly aggregate (incrementing counts), then delete the detailed row. Process in batches of 1000.
- Per §25.2 “Retrieval logs (detailed): 90 days, then aggregated.”
1. **RAG queue rejected items — §25.2.** Inngest scheduled function `rag-rejected-items-purge` running weekly (Sunday at 06:00 UTC):
- `DELETE FROM rag_submissions WHERE review_status = 'rejected' AND tenant_review_decision_at < NOW() - INTERVAL '90 days'`.
1. **Booking + commission retention purge — §25.2.** Inngest scheduled function `booking-commission-retention-purge` running monthly (1st of each month at 03:00 UTC):
- For `bookings` rows where `sailing_date < NOW() - INTERVAL '7 years'` AND `dispute_state NOT IN ('open','under_review')`:
  - Hard-delete the row plus dependent `booking_passengers`, `booking_options`. Audit each deletion.
- For `commissions` rows where the linked booking has been deleted by the above rule: hard-delete the commission row.
- Audit log retention (§26.5 “7 years”) is managed separately; this cron does NOT touch `audit_log`.
- Wrap each tenant’s purge in `withPlatformAdminAudit` per §26.3a discipline since this is a cross-tenant operation.
1. **CCPA delete request → purge job — closing the Part 4 stub.** Update `apps/main/src/inngest/user-data-purge-after-grace.ts`:
- The function exists from Part 4 Prompt 17 with a `// TODO(part-6)` stub.
- Now: call `purgeUserDataPerRetention({ user_id })`.
- On success: also update `users.status = 'deleted' → 'purged'` (handled inside the function in Step 8).
- On failure: leave `users.status = 'deleted'`, alert platform admin, `ccpa_deletion_executions.purge_outcome = 'error'` (already done inside the function).
- Schedule: the cron checks `users WHERE status = 'deleted' AND deleted_at + INTERVAL '30 days' <= NOW()` and processes each.
1. **CCPA staging-propagation behavior — closing the Part 4 Prompt 17 monitor.** The staging-propagation monitor from Prompt 17 alerts when staging refresh is overdue. The CI/CD pipeline is separate (already built per operator). Verify the monitor reads `platform_settings.last_staging_refresh_at` — if the field is populated by the pipeline, the monitor works as-is; if not, document the integration point in MEMORY as a one-time operator wire-up.
1. **Tenant CRM-notes anonymization UI — §25.4a Category 3.** When a customer is purged AND tenant CRM notes were anonymized for that tenant:
- Create an in-app notification (using the Part 5 Prompt 23 `notifications` table) targeted at the `tenant_admin` role for affected tenants: title “Customer removed under CCPA — review your notes for residual PII”, body explains that text was preserved but FK anonymized.
- In the tenant admin notifications panel, surface a count of anonymized-FK notes per tenant.
- Link to a filtered notes view at `/tenant-admin/crm/anonymized-notes` showing only notes with non-null `anonymized_customer_hash` (or NULL `customer_user_id` with non-null `customer_hash` — exact filter depends on the schema choice from Task 5 Step 5), with an inline editor to redact text. Save action writes the redacted text back to the note row.
1. **Cookie consent plumbing — §25.8.** Build the cookie consent banner:
- First-visit banner with three options: Accept all / Essential only / Customize.
- Categories per §25.8:
  - **Essential** (always on; non-toggle): session, security, basic preferences.
  - **Performance** (opt-out default ON): analytics.
  - **Marketing** (opt-in default OFF): cross-site retargeting.
- User choices stored in a first-party `cookie_preferences` cookie (it’s the persistence layer for the preference itself) AND mirrored to `users.cookie_preferences` JSONB for authenticated users (add this column to `users` in the migration).
- Settings page at `/settings/privacy/cookies` lets the user revise.
- Per-cookie inventory documented at `docs/cookies-inventory.md` — operator content task; ship the doc as a stub with the categories table and a `// TODO(operator)` to list each cookie set by each subdomain/integration.
1. **Consent granularity per §25.7.** Add to `users` table if not already present (migration):
- `marketing_email_opt_in BOOLEAN NOT NULL DEFAULT FALSE`
- `travel_news_opt_in BOOLEAN NOT NULL DEFAULT FALSE`
- `memory_opt_out BOOLEAN NOT NULL DEFAULT FALSE`
- `performance_analytics_opt_out BOOLEAN NOT NULL DEFAULT FALSE`
- The settings page `/settings/privacy` lets the user toggle each. Labels and explanatory copy match §25.7.
- `memory_opt_out=TRUE` disables the Part 3 Prompt 12 customer-memory extraction for this user. Update the memory-extraction Inngest job to short-circuit on this flag. Verify the flag is read at job start (not cached) so toggle effects are immediate on next conversation.
1. **Breach response runbook — §25.9 + §26.10.** Ship `docs/runbooks/breach-response.md` with:
- The seven-step process from §26.10 (detect → triage → contain → investigate → notify → remediate → post-mortem).
- The §25.9 SLAs: affected users within 72 hours, tenant admins within 24 hours, California AG per state law, public disclosure when applicable per state law.
- The contact list template (operator fills in) for legal counsel, oncall engineer, executive escalation, California AG office.
- Decision tree mapping severity (data class affected × number of records × confirmed-vs-suspected) to notification channels and timing.
- Email templates at `apps/main/src/emails/BreachNotificationUser.tsx` and `BreachNotificationTenantAdmin.tsx` extending BrandedLayout (from Part 4 Prompt 18). Templates take a `breach_summary` prop and render standard notification copy with the summary slotted in. **The exact wording is `// TODO(legal-counsel)` — same attorney engagement from Part 4 Prompts 16/17/18.**
- A `sendBreachNotifications({ severity, affected_user_ids, affected_tenant_ids, summary })` helper that batches sends with the right SLA timing.
1. **§25.10 staging risk-acceptance documentation and control verification.** Ship `docs/runbooks/staging-pii-risk-acceptance.md` enumerating the controls per §25.10:
- **Outbound isolation.** Verify wrappers at `apps/main/src/lib/email/send.ts` (and any SMS wrapper if it exists) apply `TEST_OVERRIDE_EMAIL` and `TEST_OVERRIDE_PHONE` env vars when `process.env.STAGING_MODE === 'true'`. If the wrappers aren’t in place: wire them now. Add an integration test that asserts a staging-mode email send hits the override address.
- **External-service neutering.** The post-restore fixup is in the separate CI/CD pipeline doc; this prompt documents the dependency.
- **Background job suppression.** Verify all Inngest crons check `STAGING_MODE` and either skip OR write to a `staging_cron_skips` log table for visibility. If the check isn’t in place on existing crons from earlier prompts: add it.
- **Access scope.** Documented; no code change.
- **Refresh hygiene.** Documented; depends on the CI/CD pipeline already in place.
1. **Sub-processors disclosure — §25.5.** Render the sub-processors list at `/legal/sub-processors`:
- Anthropic, OpenAI, Supabase, Vercel, Stripe, Resend, Inngest, Sentry per §25.5.
- Each row shows the vendor and the data category they process.
- Annual update reminder cron `subprocessors-annual-review` runs January 1 each year and emails the operator a checklist.
1. **CCPA right-to-correct surfaces — §25.3.** Already mostly in place from Part 4 Prompts 16/17 and Part 3 Prompt 12. Verify:
- `/settings/profile` lets the user edit their `users` columns.
- `/settings/memory` lets the user edit / delete entries in `customer_memories`.
- Both are immediate (per §25.3 “Right to correct: Immediate”).
- No new work unless gaps are found; document any gaps in MEMORY.
1. **Tests.**
- **purgeUserDataPerRetention** on a fixture customer with: 5 chat messages, 2 quotes with narratives, 3 bookings, 1 customer_memory, 2 tenant CRM notes:
  - After purge: messages.content all NULL; quote.narrative NULL on both; bookings have anonymized_customer_hash + anonymized_at set, customer_user_id NULL, denormalized PII cleared; customer_memories row deleted; tenant CRM notes: text preserved, FK NULL or anonymized_customer_hash set.
- **Customer hash determinism**: same (user_id, tenant_id) returns identical hash across multiple calls. Different user_ids return different hashes.
- **Forensics snapshot taken when active dispute**: a customer with an open commission_dispute, on purge, has a forensics_log row written BEFORE the deletion; `ccpa_deletion_executions.forensics_snapshot_id` set.
- **Forensics snapshot NOT taken when no dispute**: standard deletion produces no forensics_log row.
- **Forensics failure aborts deletion**: simulate encryption failure; assert no Category 1–3 changes were applied to the user’s data.
- **Booking retention cron**: a 7-year-and-1-day-old completed booking with no dispute is deleted; one with `dispute_state='open'` is preserved.
- **Retrieval logs aggregation**: a 91-day-old detailed log row is aggregated into the monthly table; the original row is deleted; UPSERT logic for repeated (tenant, month, persona, chunk) tuples is correct.
- **Anonymous session cleanup**: a 61-day-old anonymous_chat_counters row is deleted.
- **Cookie consent banner**: appears on first visit; persists choice in `cookie_preferences` cookie AND user JSONB if authenticated; settings page lets user revise.
- **memory_opt_out=TRUE**: mock the memory-extraction job and verify it short-circuits on the flag at job start.
- **Tenant CRM notes anonymization UI**: after a customer purge that anonymizes notes, the affected tenant_admin gets a notification and the filtered view shows the anonymized rows.
- **Breach notification email templates**: render with a sample `breach_summary` prop; the BrandedLayout footer (mailing address, unsubscribe) is present.
- **Boot-time key separation check**: setting `FORENSICS_ENCRYPTION_KEY_CURRENT = APP_ENCRYPTION_KEY_CURRENT` causes a boot-time exit.
1. **Add to MEMORY.md at end of run:**
- PLATFORM_PEPPER is set once at platform genesis and NEVER rotated; document the value’s storage location (1Password vault entry name or similar).
- Tenant CRM notes actual table/column path used in Task 5 Step 5.
- Bookings denormalized-PII column names used in Task 5 Step 6.
- Forensics_log table is created here but `decryptForensicsSnapshot` and the retention cron + access controls land in Prompt 26.
- Staging mode wrappers wired/verified — list the call sites updated.
- `memory_opt_out` flag read at memory-extraction job start (no caching).
- Boot-time key separation check is active.

**Definition of done:**

- A user’s CCPA delete request, after the 30-day grace, triggers `purgeUserDataPerRetention` and the §25.4a three-category rules apply correctly.
- An active-dispute customer’s purge takes a forensics snapshot FIRST; absent a dispute, no snapshot.
- A forensics encryption failure aborts the deletion without partial state changes.
- The customer-hash derivation is deterministic and lands consistently in `bookings`, `commissions`, and the CRM-notes path.
- Retention crons enforce: 60-day anonymous sessions, 90-day detailed retrieval logs with aggregation, 90-day RAG rejected items, 7-year booking + commission with active-dispute guard.
- Cookie consent banner persists per-category preferences; settings page lets users revise; `memory_opt_out` toggle is honored immediately.
- Sub-processors page renders; annual reminder cron registered.
- Breach response runbook and email templates in place with attorney `// TODO` markers.
- §25.10 staging risk-acceptance controls are documented and wired (outbound isolation wrappers, cron staging-mode checks).
- Boot-time check confirms `FORENSICS_ENCRYPTION_KEY_CURRENT ≠ APP_ENCRYPTION_KEY_CURRENT`.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:migrations` all pass.

**After completion:** MEMORY.md entry per Task 20.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```