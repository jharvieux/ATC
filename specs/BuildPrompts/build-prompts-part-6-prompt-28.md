# Build Prompts — Spec v6.2, Part 6 (continued)

**This file contains Build Prompt 28 only.** Prompts 25, 26, and 27 were in prior files. This is the last Part 6 prompt.

-----

# BUILD PROMPT 28 — Abuse monitoring: recompute crons, notifications, overrides, admin and tenant UI

```
═══════════════════════════════════════════════════════════════
MODEL: claude-sonnet-4-6
SWITCH-BACK-AT-END: (already sonnet — no switch needed)
═══════════════════════════════════════════════════════════════
```

**Spec references:** Part 6 §27.7 (recompute strategy — real-time event-driven + daily cron safety net), §27.8 (state-transition notifications), §27.9 (override workflow — admin grants temporary or permanent), §27.10 (admin dashboard at `/admin/abuse-monitoring`), §27.11 (tenant-facing usage UI at `/settings/usage`), §27.13 (integration with existing sections — Part 4 §15 onboarding, Part 5 §22 RAG ingestion, etc.), §27.14 (calls worth flagging — billing period anchor, override audit, override expiry), §27.15 (acceptance criteria summary). Depends on Build Prompt 27 (the schema, threshold resolver, state machine, and per-dimension enforcement are all in place).

**Prerequisite check:** Build Prompts 01–27 are committed. The five-dimension counters increment correctly; the state machine emits `abuse.state_transition` events; the `abuse_signals` table receives Part 5 events.

**Goal:** Build the daily recompute safety-net crons, the state-transition notification flow (tenant + platform admin), the override workflow (admin grants temporary or permanent overrides with audit), the platform admin dashboard at `/admin/abuse-monitoring`, the tenant-facing usage UI at `/settings/usage`, the group-invite pre-approval queue UI, and the billing-period rollover handling.

**Tasks:**

1. **Env vars.** Extend `apps/main/src/lib/env.ts`:
   
   ```
   ABUSE_RECOMPUTE_CRON_SCHEDULE (default '0 3 * * *' — 03:00 UTC daily)
   ABUSE_OVERRIDE_DEFAULT_DURATION_DAYS (default 30)
   ABUSE_TENANT_USAGE_REFRESH_SECONDS (default 60)
   ```
1. **Daily recompute safety-net cron — §27.7.** Inngest scheduled function `abuse-recompute-nightly` running daily at 03:00 UTC:
- Wrapped in `withPlatformAdminAudit` per Prompt 26 service-role discipline; `reason='abuse_metrics_nightly_recompute'`.
- For each active tenant (`status IN ('active', 'sandbox')`):
  - **AI cost recompute:** SUM `ai_call_log.cost_estimate_cents WHERE tenant_id = $1 AND created_at >= billing_period_start AND created_at < billing_period_end`. Compare to current `tenant_usage_metrics.ai_cost_cents`. If divergent by > 1 cent (real-time UPSERTs can drift on rare conflict retries): update the metric AND log the drift to a `abuse_recompute_drift_log` table (created in this migration: `id UUID PK, tenant_id, dimension, real_time_value, recomputed_value, drift_amount, billing_period, detected_at`).
  - **Chat volume recompute:** COUNT `messages WHERE conversation.tenant_id = $1 AND sender_role = 'assistant' AND created_at IN billing_period`. Same drift check.
  - **Email volume recompute:** COUNT `email_log WHERE tenant_id = $1 AND created_at IN billing_period AND status NOT IN ('suppressed', 'failed')`. Drift check.
  - **Group invite recompute:** COUNT `invitations` rows created by this tenant in billing_period.
  - **RAG quota recompute:** COUNT `knowledge_chunks WHERE origin_tenant_id = $1 AND scope = 'tenant'` (the RAG-side count, via service-to-service call to the RAG service from Prompt 08); COUNT promoted chunks from `rag_global_promotions WHERE demoted_at IS NULL`. Update `tenant_rag_quotas` with both counts. Drift check.
- After recompute: re-evaluate state machine for each tenant via `checkStateTransitionIfNeeded` (Prompt 27 Task 8). The monotonic rule means state can advance but not retreat within the billing period — recompute can advance state if a tenant crossed a threshold without the real-time path catching it.
- Cron audit row records: tenants processed, drift count, time elapsed.
1. **Billing period rollover cron — §27.14 calls worth flagging.** Inngest scheduled function `abuse-billing-period-rollover` running daily at 00:05 UTC:
- For each tenant whose `billing_period_anchor` (or calendar month for monthly billing) just rolled over to a new period:
  - INSERT a new `tenant_usage_metrics` row for the new period with all counters at 0 and all state columns at `'ok'`.
  - The PRIOR period’s row stays for historical reporting (queryable from the admin dashboard).
- For tenants on annual billing: rollover is monthly for visibility, but the `effective_monthly_revenue` from Prompt 27’s `revenue.ts` continues to use the annual÷12 calculation.
- **The monotonic state rule resets at billing-period boundary.** A tenant who was at `hard` last month starts at `ok` for the new month and progresses again based on the new period’s usage.
- Document the billing-period anchor source in MEMORY: is `tenants.billing_period_anchor` populated by Stripe webhook at subscription creation (Part 4 Prompt 16), or computed each query? Whichever, document the canonical source.
1. **State-transition notification consumer — §27.8.** Inngest function `abuse-state-transition-notifier` listening for `abuse.state_transition` events (emitted by Prompt 27 Task 8):
- For each event, build a notification payload for both audiences:
  - **Tenant notification (sent to all users with `tenant_admin` or `tenant_billing_admin` role for the tenant):**
    - In-app via `notifications` table (Prompt 23).
    - Email via `sendEmail` with category `'transactional'` (these aren’t marketing).
    - Tone per state:
      - `soft1`: informational. Subject: “You’ve reached 30% of your monthly [dimension] capacity.” Body: explains the band, suggests reviewing usage. No alarm.
      - `soft2`: heads-up. Subject: “50% of your monthly [dimension] capacity used.” Body: explains the band; mentions enforcement behaviors (e.g., “responses may be slightly slower until your next billing period”); link to `/settings/usage`.
      - `hard`: action-required. Subject: “Monthly [dimension] limit reached.” Body: explains the block; explains how to request an override; link to `/settings/usage`.
    - For RAG `approaching` and `at_cap` states: use language per §27.4.2 (mentioning the promotion-bonus mechanism).
  - **Platform admin notification** (in-app only; not email — too noisy across many tenants):
    - Appears in `/admin/abuse-monitoring` (Task 8) as a live event in the activity feed.
    - Severity badge: soft1 = info, soft2 = warning, hard = critical.
- Email templates `apps/main/src/emails/AbuseStateTransition.tsx` extending BrandedLayout. Per-dimension copy slotted from `platform_settings.abuse_notification_copy` JSONB (operator-editable so wording can be tuned without redeploy).
1. **Override workflow — §27.9.** Build the override creation flow:
- **Endpoint `POST /api/admin/abuse-overrides`** — platform_super_admin role only:
  - Body: `{ tenant_id, dimension, tier_override ('soft1'|'soft2'|'hard'|'approaching'), threshold_value, reason, effective_from?, effective_to?, audit_note }`.
  - Validates: tenant exists; dimension is one of five; threshold_value is positive; effective_from defaults to today; effective_to defaults to today + `ABUSE_OVERRIDE_DEFAULT_DURATION_DAYS` (30); if `effective_to=null` is explicitly sent, the override is permanent.
  - Wrapped in `withPlatformAdminAudit` with `reason='abuse_override_created'`.
  - Inserts `tenant_usage_overrides` row with the values.
  - After insert: re-evaluate state machine for the tenant (the new threshold may immediately drop the tenant back to `ok` from a `hard` state — recall RAG is non-monotonic; monthly dimensions stay at their current rank but the threshold value used for future increments changes).
  - Returns the override id.
- **Endpoint `DELETE /api/admin/abuse-overrides/:id`** — platform_super_admin role only:
  - Sets `effective_to = NOW()` (preserves history rather than hard-deleting).
  - Wrapped in `withPlatformAdminAudit` with `reason='abuse_override_revoked'`.
- **Override expiry cron** `abuse-override-expiry-sweep` running daily at 00:30 UTC:
  - Finds overrides where `effective_to < NOW()` AND no expiry notification has been sent (track via a `expiry_notified_at` column added in this migration).
  - For each: sends an in-app notification to platform admin: “Override for [tenant] / [dimension] / [tier] has expired.” Sets `expiry_notified_at = NOW()`.
  - Per §27.14 “Override expiry should fire a notification, not just silently revert.”
1. **Group invite pre-approval queue UI — finishes Prompt 27 Task 9 soft2 path.** `/admin/abuse-monitoring/group-invite-queue`:
- Lists rows from `group_invite_pending_approval` where `status='pending'`.
- Each row: requesting tenant, group title, invitee count, requested at, action buttons (Approve / Deny + reason).
- **Approve:** sets `status='approved'`; emits Inngest event `group_invite.batch_approved` which the existing send path consumes to actually send the invitations.
- **Deny:** sets `status='denied'`, `reviewed_by`, `reviewed_at`, deny-reason captured; the requesting tenant gets an in-app notification.
- Both actions wrapped in `withPlatformAdminAudit`.
1. **Platform admin dashboard — §27.10.** `/admin/abuse-monitoring`:
- Tabs:
  - **Escalation watch:** tenants currently in `soft2` or `hard` state on any dimension. Sortable by dimension + state + days-in-state. Click into a tenant → tenant detail page.
  - **Recent state transitions:** chronological feed of `usage_limit_events` from the last 7 days; filter by dimension + severity.
  - **Abuse signals:** rows from `abuse_signals` with `acknowledged_at IS NULL`. Each row has an Acknowledge button (sets `acknowledged_at`, `acknowledged_by_user_id`). Inline link to the tenant detail.
  - **RAG cap events:** rows from `tenant_rag_cap_events` (auto-deletes, promotion bonus increments). Read-only feed.
  - **Active overrides:** all current `tenant_usage_overrides` rows where `effective_to IS NULL OR effective_to > NOW()`. With revoke action.
- **Tenant detail page** `/admin/abuse-monitoring/tenant/:tenant_id`:
  - Header: tenant name, tier, seat count, billing period, effective monthly revenue.
  - Five panels (one per dimension): current usage / soft1 / soft2 / hard / current state / state-since timestamp / sparkline of last 30 days.
  - RAG panel: current chunks, promoted chunks count, base cap, effective cap (base + bonus), at-cap status.
  - Override panel: existing overrides for this tenant; “Add override” button opens a modal calling the Task 5 endpoint.
  - Recent ai_call_log feed (last 100 rows) for AI cost diagnostics.
  - Recent abuse_signals for this tenant.
- All page loads wrapped in `withPlatformAdminAudit` with `reason='abuse_dashboard_view'` and the route as detail.
1. **Tenant-facing usage UI — §27.11.** `/settings/usage` (visible to `tenant_admin`, `tenant_billing_admin`):
- Five dimension panels, simpler than admin view:
  - Current period (e.g., “April 2026”).
  - Current usage / soft1 / soft2 / hard with a progress bar.
  - Plain-language state indicator: “All clear” / “Approaching limit” / “At limit” / “Exceeded limit.”
  - Enforcement-behavior copy for the current state (e.g., “Responses may be slightly slower” at chat soft1).
- For RAG: current chunks / base cap / bonus from promotions / effective cap. Plus a callout: “Each piece of content promoted to platform-wide knowledge adds 25 slots permanently to your cap.”
- For Email: separately show daily count vs daily cap, AND monthly count if relevant. The bounce-rate side-channel pause (if active) shows a prominent banner: “Email sending is paused because your bounce rate exceeded 5% in the last 24 hours. The pause will lift automatically once the bounce rate drops.”
- Refresh: page auto-refreshes (or polls every `ABUSE_TENANT_USAGE_REFRESH_SECONDS`) so a tenant watching the page sees live state transitions.
- **The tenant CANNOT see overrides applied to them in this UI.** Overrides are platform-admin-side; the tenant just sees their effective caps. (This is the §27.11 “tenants see effective caps, not the override metadata” interpretation. Document in MEMORY.)
- “Request more capacity” CTA → opens a form that posts to `POST /api/tenant/abuse-override-request` (new endpoint) — creates a row in a `tenant_override_requests` table (`id, tenant_id, dimension, requested_threshold_kind, current_state, reason, requested_at, status CHECK IN ('pending','approved','denied'), reviewed_at, reviewed_by`). Platform admin queue surface: a tab on `/admin/abuse-monitoring` titled “Override Requests.” Approve creates a `tenant_usage_overrides` row via Task 5.
1. **Cost attribution display — §27.12.** On the platform admin tenant-detail page, add an AI cost breakdown table:
- Rolling 30-day window.
- Group by `purpose` enum value.
- Show sum cost_estimate_cents per purpose, count of calls, average tokens per call.
- This is the operator’s view into where a high-cost tenant is spending — chat_main vs supervisor vs RAG normalization, etc.
1. **Integration verification — §27.13.**
- **Part 4 §15 onboarding integration:** Verify that a freshly-activated tenant has `tenant_usage_metrics` row inserted on activation (or lazily on first counter increment — either is fine; document the choice).
- **Part 5 §22 RAG ingestion integration:** Verify the auto-delete path from Prompt 27 Task 10 fires correctly for over-cap tenants. Integration test: tenant at cap, submit a low-relevance chunk, verify auto-delete + `tenant_rag_cap_events` row.
- **Part 5 §24 customer chat limit integration:** The customer-facing 3-tier limit from Prompt 24 is SEPARATE from the tenant-side chat volume dimension. Both can fire independently. Verify the two limits don’t interact in unexpected ways (e.g., a tenant in chat-volume soft1 enforcement, the customer hits their own soft1 — both add delays; the result is additive but not multiplicative). Document in MEMORY.
- **Stripe subscription changes:** When `tenant.subscription_changed` event fires from Part 4 Prompt 16 (tier change, seat change, billing period change): re-evaluate thresholds for the tenant — the new revenue computation produces new threshold values immediately. The state machine state itself doesn’t reset (monotonic per billing period) but the threshold values used for future evaluations update. Build Inngest function `abuse-threshold-recompute-on-subscription-change` listening for the event.
1. **Tests.**
- **Nightly recompute drift detection:**
  - Manually corrupt a `tenant_usage_metrics.ai_cost_cents` value; run the cron; assert the value is corrected and `abuse_recompute_drift_log` records the drift.
- **Billing period rollover:**
  - Set a tenant’s billing anchor; advance test time past the rollover; run the rollover cron; assert a new `tenant_usage_metrics` row exists with zeroed counters and `'ok'` states; the prior row preserved.
- **State-transition notification:**
  - Tenant crosses ai_cost soft1 threshold → in-app notification created for tenant_admin AND tenant_billing_admin; email sent; appears in admin dashboard activity feed.
  - Soft2 transition produces the heads-up-tone email.
  - Hard transition produces the action-required email with override-request link.
- **Override creation:**
  - Admin creates an override for a tenant in `hard` state with a new threshold above current usage; subsequent counter increments for that tenant correctly use the new threshold.
  - Override with `effective_to` in the past → not applied.
  - Override revocation → preserved with `effective_to = NOW()`; not applied going forward.
  - Override expiry cron sends a notification when an override naturally expires.
- **Group invite pre-approval queue:**
  - Tenant in soft2 submits an invite batch > 20 → row created in `group_invite_pending_approval` with status=‘pending’.
  - Admin approves → `group_invite.batch_approved` event fires, the existing send path picks it up.
  - Admin denies → tenant gets in-app notification.
- **Admin dashboard:**
  - Escalation watch tab shows tenants currently in soft2 or hard on any dimension.
  - Tenant detail page renders five dimension panels with current values.
  - All page loads write a `withPlatformAdminAudit` row.
- **Tenant usage UI:**
  - Tenant sees their own current period usage with progress bars.
  - Tenant CANNOT see override metadata in the UI (only effective caps).
  - Bounce-rate pause banner shows when `tenant_settings.email_paused_due_to_bounce_rate=TRUE`.
  - “Request more capacity” form submits a `tenant_override_requests` row.
- **Subscription change recompute:**
  - Tenant changes from Pro to Agency seat 6 → threshold recomputation runs; new effective caps reflect Agency revenue.
  - State doesn’t reset to `ok` if the tenant was at `soft2` before the change (monotonic).
1. **Add to MEMORY.md at end of run:**
- Whether `tenant_usage_metrics` rows are created on tenant activation OR lazily on first counter increment — document which.
- The billing-period anchor source — `tenants.billing_period_anchor` populated by which Part 4 Prompt 16 path.
- Tenant-side UI deliberately hides override metadata (effective caps only); operator can change this later if desired.
- The Part 5 Prompt 24 customer-chat-limit and Part 6 Prompt 27 tenant chat-volume-limit are independent — both can fire concurrently with additive effect.
- The `abuse_recompute_drift_log` table is created here for ongoing drift visibility; expect occasional drift on production from UPSERT conflict retries.
- Override-request flow (tenant requests; admin approves) is built; document the table names and the routes.
- Per §27.14 calls worth flagging: override expiry notifications are wired (Task 5 cron); billing-period rollover preserves history.

**Definition of done:**

- Nightly recompute cron runs and corrects drift; `abuse_recompute_drift_log` records any drift detected.
- Billing-period rollover creates fresh per-period metric rows; prior periods preserved.
- State-transition notifications reach both audiences with right tone per state.
- Admin can create + revoke overrides; expiries fire notifications.
- Group invite pre-approval queue surface allows admin to approve / deny pending batches.
- Platform admin dashboard at `/admin/abuse-monitoring` surfaces escalation watch, transitions, signals, RAG events, overrides.
- Tenant usage UI at `/settings/usage` shows current usage with progress bars and request-more-capacity flow.
- Subscription change events trigger threshold recompute.
- All admin operations audited via `withPlatformAdminAudit`.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:migrations` all pass.

**After completion:** MEMORY.md entry per Task 12.

-----

## End of Part 6 build prompts

**After all four Part 6 prompts complete, you have:**

- **Compliance backbone.** CCPA delete actually deletes per the §25.4a three-category rules — chat messages NULLed, AI narratives NULLed, tenant-authored CRM notes anonymized via deterministic customer hash. Forensics snapshot taken BEFORE deletion when the customer has an active dispute. Retention crons enforce 60-day anonymous sessions, 90-day detailed retrieval logs, 90-day rejected RAG submissions, 7-year booking + commission. Cookie consent with per-category preferences and `memory_opt_out`. Sub-processors page rendered. Breach response runbook + email templates in place. §25.10 staging-PII risk-acceptance controls verified.
- **Security backbone.** Four-layer auth documented; `assertPermission` reconciled to spec with sensitive-action re-auth via `auth_time` freshness. Service-role discipline enforced via CI lint with hard-fail on direct `createServiceRoleClient`, direct `SUPABASE_SERVICE_ROLE_KEY` import, or ad-hoc `tenant_id: string` function parameters. `withPlatformAdminAudit` produces one audit row per platform-admin operation, nested-call-aware, transaction-rollback-safe. Partial GIN index on `audit_log.changes` keeps user-action writes fast. Forensics_log access controls live: decrypt requires `withPlatformAdminAudit`; legal-hold helper available; 90-day retention cron; key-rotation grace works; `FORENSICS_ENCRYPTION_KEY_CURRENT` verified separate from credentials keys at boot. Webhook context factories resolve correctly and audit-log every resolution. Vendor outage degraded-mode hooks render correctly. Sentry config strips PII. Incident response runbook in place.
- **Cost-control backbone.** Five dimensions monitored: AI cost (with thresholds at 30/50/70% of subscription revenue), chat volume, email volume, group invitations, RAG submissions (with the unique total-cap-plus-promotion-rewards model). Per-call AI cost attribution to the tenant who caused the call via the instrumented wrapper that ALL Anthropic/OpenAI calls flow through. Threshold resolver is one source of truth using effective monthly revenue with multi-seat × billing-period multiplier. Real-time event-driven counter increments + daily recompute safety net. Monotonic state machine within billing periods; RAG state non-monotonic. Per-dimension enforcement: AI cost swaps model at soft1, tightens at soft2, blocks at hard; chat volume delays then blocks; email queues then blocks plus bounce-rate side channel; group invitations require confirmation then admin pre-approval then block; RAG over-cap auto-deletes new low-relevance submissions while promotion bonus persists permanently. Override workflow with audit and expiry notifications. Admin dashboard and tenant-facing usage UI.

**What’s left to build after Part 6:**

- Part 7 §28 Observability — operational metrics and dashboards.
- Part 7 §30 Code Quality — testing standards, code-review practices, naming conventions.
- Part 9 §32 Self-Service Help — help section, defect capture, feature request capture, RAG-indexed platform docs.

The platform after Part 6 is **operable** end-to-end: customer signs up, chats, gets a quote, books, pays — with compliance, security, and cost controls all enforced. The remaining parts add operator-facing observability + code-quality discipline + customer/tenant self-service for support cases.