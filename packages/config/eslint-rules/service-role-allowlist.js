"use strict";

// Spec ref: §5.4.4 — allowlist DATA for eslint-rules/no-direct-service-role-import.js.
//
// Full path suffixes for files permitted to import service-role-client.ts
// directly (i.e. allowed to bypass RLS). Every entry MUST carry a // comment
// naming the spec section / issue that justifies the bypass.
//
// This is a SECURITY BOUNDARY. A raw service-role client defeats tenant
// isolation, so this list is the single auditable record of every sanctioned
// exception — a reviewer should be able to read it top-to-bottom and verify
// each one. Keep it centralized; do NOT decentralize into per-file opt-in
// comments.
//
// Full path suffixes for allowed callers. Using path suffixes (not bare
// filenames) avoids false positives if a future file happens to share a name.

module.exports = [
  "/lib/db/tenant-client.ts",
  "/lib/db/platform-admin-client.ts",
  // §26 platform-admin session gate: looks up auth_user_id in platform_admins,
  // which is a service-role-only table (all RLS policies deny authenticated).
  "/lib/auth/assert-platform-admin.ts",
  // Post-login dispatcher: decides where a freshly-authenticated user lands.
  // Looks up platform_admins (service-role-only) and a cross-tenant
  // users+tenants join — at this point there is no resolved tenant context,
  // so RLS-aware clients have nothing to scope to. Read-only.
  "/lib/auth/resolve-post-login.ts",
  // BP34 §34.2.4: request-scoped tenant tier-code read for server-component
  // layouts (e.g. the CRM Gmail-health banner) that gate UI by tier and have
  // no assertPermission ctx to scope an RLS-aware client with. Reads only the
  // non-PII tier code; read-only. Same pattern as fetch-tenant-branding.ts.
  "/lib/tenancy/request-tenant-tier.ts",
  // Public landing tenant-branding fetch: anonymous visitors hitting
  // tenant subdomains need to see the tenant's display_name + logo +
  // slogan before any auth happens. RLS on tenant_branding requires
  // authenticated tenant membership; we can't scope that for anon. The
  // fields read are all public-marketing-only (no PII, no credentials).
  // Read-only.
  "/lib/branding/fetch-tenant-branding.ts",
  // Public agent-profile customer-bio fetch: anonymous visitors hitting
  // /agents/[slug] need to see the bio platform admins author. RLS on
  // personas requires authenticated users; the customer_bio column is
  // explicitly public-marketing content per #652. Read-only.
  "/lib/agents/fetch-customer-bio.ts",
  // Middleware tenant resolver: runs before any user context exists, so
  // service-role is the only viable client. See BP04 / spec §1.4.
  "/lib/tenancy/resolve-tenant.ts",
  // Stripe webhook handler: operates before any user session; service-role
  // required for the idempotency insert into stripe_webhook_events. §7.9a.
  "/lib/stripe/webhook-handler.ts",
  // Vercel cron reconciliation job: background cron outside any user
  // session; service-role required to scan stripe_webhook_events. §7.9a.
  "/lib/cron/stripe-webhook-incomplete-reconcile.ts",
  // DOB re-prompt cron: cross-tenant scan, no user session. §11.5.
  "/inngest/dob-estimate-reprompt-eligible.ts",
  // Platform-internal admin endpoint: bearer-token auth, no user JWT. §8.3.
  "/api/admin/tenants/route.ts",
  // D-041 follow-up — platform_settings list endpoint for rag reconcile cron.
  // Same bearer-token auth pattern as /api/admin/tenants.
  "/api/admin/platform-settings/route.ts",
  // Supervisor dashboard: platform admin Server Component — reads cross-tenant
  // metrics. TODO(§26): replace with withPlatformAdminAudit once admin session
  // auth lands. Until then, this page is gated by the admin route group layout.
  "/app/(admin)/supervisor/page.tsx",
  // BP13: Anon-to-auth transfer finalize — background Inngest job, no user session. §11.4.
  "/inngest/transfer-finalize.ts",
  // BP14: Credential re-encryption cron — background Inngest job, no user session. §13.5.
  "/inngest/re-encrypt-old-records.ts",
  // BP14: Host adapter registry — loads adapter implementations from DB. §13.3.
  "/lib/host-adapters/registry.ts",
  // BP14: Adapter selection — reads tenant host configs and decrypts credentials. §13.7.
  "/lib/host-adapters/select-adapter.ts",
  // BP14: Credential health check — reads tenant host configs across tenants. §13.5.4.
  "/lib/host-adapters/credential-health.ts",
  // BP15: Commission split Inngest job — writes payout_records and platform_revenue. §14.3.
  "/inngest/commission-split-on-received.ts",
  // BP15: Payouts mark-available cron — cross-tenant payout_records scan. §14.6.
  "/inngest/payouts-mark-available.ts",
  // BP15: Payouts execute-transfer cron — Stripe transfer, no user session. §14.7.
  "/inngest/payouts-execute-transfer.ts",
  // BP15: Payouts reconcile-processing cron — cross-tenant recovery scan.
  // Moved to a Vercel cron (#894). §14.7.
  "/lib/cron/payouts-reconcile-processing.ts",
  // D-091 R3 #51 follow-up: bookings stuck-submitting reconcile cron —
  // cross-tenant sweep of bookings stuck in 'submitting' state. Moved to a
  // Vercel cron (#894). §14.4.
  "/lib/cron/bookings-stuck-submitting-reconcile.ts",
  // D-097 — help-AI message route needs service-role for the
  // loadTenantSnapshot + incrementChatMessages helpers (same pattern
  // as the customer chat route). All upstream queries already use
  // tenantClient(ctx); the service-role client is scoped to the abuse
  // snapshot + counter increment. §32.4.4.
  "/app/api/help/sessions/[id]/message/route.ts",
  // BP15: Statement reconciliation cron — cross-tenant daily fetch + match. §14.8.
  "/inngest/reconcile-statement-automated.ts",
  // BP15: Commission state machine — transitionCommissionState uses service_role
  // for the DB update. All callers are route handlers or Inngest jobs that have
  // already validated tenant context before calling this. §14.2.
  "/lib/commissions/state-machine.ts",
  // BP15: Booking submit — reads tier_definitions and writes commissions (locked rates). §14.3.
  "/app/api/bookings/[id]/submit/route.ts",
  // BP15: Booking cancel — reads payout_records for clawback logic. §14.9.
  "/app/api/bookings/[id]/cancel/route.ts",
  // BP15: Subcontractors — reads tenant.tenant_type to gate sub_host access. §14.3a.
  "/app/api/subcontractors/route.ts",
  // BP15: Reconciliation upload — processLineItem writes to reconciliation_review_queue. §14.8.
  "/app/api/admin/reconciliation/upload/route.ts",
  // BP16: Onboarding state machine — progressTo/revertTo do cross-tenant stage writes. §15.2.
  "/lib/onboarding/state-machine.ts",
  // BP16: Slug check — reads across tenants for uniqueness check. §15.3.
  "/app/api/tenants/slug-check/route.ts",
  // BP16: Tier selection — reads tier_definitions across tenants. §15.8.
  "/app/api/onboarding/tier/route.ts",
  // BP16: ICA acceptance — reads tenant row to compare legal_name. §15.5.
  "/app/api/onboarding/ica/route.ts",
  // BP16: Profile submission — cross-tenant slug uniqueness check. §15.3.
  "/app/api/onboarding/profile/route.ts",
  // BP16: Sandbox toggle — reads tenant stripe subscription ID. §15.12.
  "/app/api/tenant/sandbox/route.ts",
  // BP16: Billing management — reads tier_definitions and subscription IDs. §15.15.
  "/app/api/tenant/billing/route.ts",
  // BP16: Admin review action — reads tenant for Stripe calls, updates status. §15.11.
  "/app/api/admin/tenants/[id]/review/route.ts",
  // BP16: Compliance nightly cron — cross-tenant inactivity scan. §15.13.
  "/inngest/compliance-nightly.ts",
  // BP16: Tax-form Stripe link — creates Connect account, needs cross-tenant write. §15.6.
  "/app/api/onboarding/tax-form/stripe-link/route.ts",
  // BP16: Connect link — reads Connect account ID for account link creation. §15.9.
  "/app/api/onboarding/connect/link/route.ts",
  // BP16: Subscription Checkout — reads tier/seat/billing_period for Checkout session. §15.8.
  "/app/api/onboarding/subscription/checkout/route.ts",
  // §15.8 / EPIC #1336 — Public pricing preview: anonymous pre-signup endpoint
  // reads global pricing reference data (tier_definitions price columns +
  // pricing_seat_ladder, both RLS-zero-policy + PLATFORM_READABLE) via
  // loadPricingTable. No tenant context exists; data is public marketing pricing
  // (no PII). Read-only.
  "/app/api/pricing/preview/route.ts",
  // BP16: Platform settings host-agency-name — reads platform_settings. §15.7.
  "/app/api/platform/settings/host-agency-name/route.ts",
  // BP16: Admin review queue — paginated cross-tenant read. §15.11.
  "/app/api/admin/tenants/review-queue/route.ts",
  // BP17: Legal acceptance (onboarding stage 3) — writes legal_consents rows.
  // legal_consents INSERT RLS is WITH CHECK(FALSE); service_role required. §15.4 / §17.4.
  "/app/api/onboarding/legal/route.ts",
  // BP17: Consent renewal — verifies auth then writes legal_consents. §17.4.
  "/app/api/user/consent/route.ts",
  // BP17: Termination handler — reads tenant for Stripe, updates status. §15.14.1.
  "/app/api/admin/tenants/[id]/terminate/route.ts",
  // BP17: Tenant termination Inngest — finalizes termination, calls RAG. §15.14.2.
  "/inngest/tenant-on-terminated.ts",
  // BP17: Tenant termination finalize cron — cross-tenant nightly scan that
  // drives suspended-past-window tenants to terminated. §15.14.
  "/inngest/tenant-termination-finalize.ts",
  // BP17: RAG tenant-scoped purge cron — finds terminated tenants, calls RAG. §15.14.3.
  "/inngest/rag-tenant-scoped-purge.ts",
  // BP17: CCPA export request — rate-limit check, inserts export_request row. §17.9.
  "/app/api/user/data/export-request/route.ts",
  // BP17: CCPA delete request — sets deleted_at on users. §17.10.
  "/app/api/user/data/delete-request/route.ts",
  // BP17: CCPA undo delete — clears deleted_at within grace period. §17.10.
  "/app/api/user/data/undo-delete/route.ts",
  // BP17: CCPA export build — assembles user data ZIP via Inngest. §17.9.
  "/inngest/user-data-export-build.ts",
  // BP17: CCPA purge after grace — executes retention purge stub. §17.10.
  "/inngest/user-data-purge-after-grace.ts",
  // BP17: Staging propagation monitor cron — reads platform_settings. §17.10.
  "/inngest/ccpa-staging-propagation-monitor.ts",
  // BP17: Legal docs admin API — lists and publishes versioned documents. §17.5.
  "/app/api/admin/legal-docs/route.ts",
  // BP17: Consent pending utility — checks user_consent_pending cross-tenant. §17.4.
  "/lib/consent/pending.ts",
  // BP17: Post-termination chunk review — admin reads RAG chunk metadata. §15.14.4.
  "/app/api/admin/chunks/post-termination/route.ts",
  // BP17: Consent pending list — returns pending docs with content for the consent page. §17.4.
  "/app/api/user/consent/pending/route.ts",
  // BP17: AI disclaimer page — reads current document as server component. §17.6.
  "/app/legal/ai-disclaimer/page.tsx",
  // BP18: Custom domain weekly reverify cron — cross-tenant DNS scan. §16.3.2.
  "/inngest/custom-domain-reverify.ts",
  // BP18: TXT-drift grace sweep cron — cross-tenant scan. §16.3.2.
  "/inngest/custom-domain-txt-grace-sweep.ts",
  // BP18: Lifecycle cleanup Inngest — reads tenants, calls Vercel. §16.3.3.
  "/inngest/custom-domain-cleanup-on-lifecycle.ts",
  // BP18: Persona addendum screen — reads addendum content, writes result. §16.6.
  "/inngest/persona-addendum-screen.ts",
  // BP18: Persona addendum nightly re-screen — cross-tenant scan. §16.6.
  "/inngest/persona-addendum-rescreen-nightly.ts",
  // BP19: Invitation token natural-expiry sweep — cross-tenant cron. §18.9.
  "/inngest/invitation-tokens-natural-expiry-sweep.ts",
  // BP19: Groups mark-sailed cron — cross-tenant status update. §18.10.
  "/inngest/groups-mark-sailed.ts",
  // BP19: Group reminder cadence — cross-tenant send + email_log write. §18.8.
  "/inngest/group-reminder-cadence.ts",
  // BP19: Hero image — reads destination_images and writes cache. §18.3.
  "/lib/groups/hero-image.ts",
  // §18 — coordinator group deletion clears non-cascading inbound FK refs
  // (email_log audit rows, group_invite_pending_approval) authenticated RLS
  // can't DELETE/UPDATE, then hard-deletes the group. Caller pre-verifies
  // tenant + coordinator ownership before invoking.
  "/lib/groups/delete-group.ts",
  // BP20: Forum threads list + create — reads/writes forum_threads. §19.7.
  // Service-role matches the established pattern in the forum subsystem (sibling messages
  // route); explicit .eq("tenant_id") provides app-layer isolation on all queries.
  "/app/api/forums/[forumId]/threads/route.ts",
  // BP20: Forum message post — writes forum_messages + calls Haiku inline. §19.3.
  "/app/api/forums/[forumId]/threads/[threadId]/messages/route.ts",
  // BP20: Forum message patch (coordinator hide/edit) — reads/writes forum_messages. §19.7.
  "/app/api/forums/messages/[id]/route.ts",
  // BP20: Forum reactions — writes/deletes forum_reactions. §19.5.
  "/app/api/forums/messages/[id]/reactions/route.ts",
  "/app/api/forums/messages/[id]/reactions/[emoji]/route.ts",
  // BP20: Forum thread patch — coordinator thread management. §19.7.
  "/app/api/forums/threads/[id]/route.ts",
  // BP20: Forum user state — coordinator mute/unmute. §19.7.
  "/app/api/forums/users/[userId]/state/route.ts",
  // BP20: Forum lock — coordinator forum-wide lock. §19.7.
  "/app/api/forums/[forumId]/route.ts",
  // BP20: Forum strikes library — reads/writes forum_strikes + forum_user_state. §19.9.
  "/lib/forums/strikes.ts",
  // BP20: Forum moderation retry Inngest — background job, no user session. §19.3.
  "/inngest/forum-moderation-retry.ts",
  // BP20: Forum moderation timeout sweep — cross-tenant cron. §19.3.
  "/lib/cron/forum-moderation-timeout-sweep.ts",
  // BP20: Booking cancel (BP15 already listed above) — clawback + commission reversal.
  // BP20: Booking modify — reads bookings + calls host adapter. §20.9.
  "/app/api/bookings/[id]/modify/route.ts",
  // BP20: DOB gate — reads booking_passengers across the booking. §20.5.
  "/lib/booking/dob-gate.ts",
  // BP21: Quote acceptance — reads tenants.name + platform_settings.host_agency_legal_name
  // for the audit PDF snapshot; tenant_settings read goes through tenantClient. §21.10.1.
  "/app/api/quotes/[id]/accept/route.ts",
  // BP21: Quote estimate expiry sweep — daily cross-tenant scan. §21.10.1.
  "/inngest/quote-estimate-expiry-sweep.ts",
  // BP22: RAG ingestion pipeline Inngest functions — background jobs, no user session. §22.4.
  "/inngest/rag-extract-content.ts",
  "/inngest/rag-pii-redact.ts",
  // BP23: Pre-cruise email scheduler cron — cross-tenant booking scan. §23.4.
  "/inngest/pre-cruise-email-scheduler.ts",
  // BP23: Pre-cruise generate and send — Haiku content + email write. §23.4.
  "/inngest/precruise-generate-and-send.ts",
  // BP23: Soft bounce retry — reads email_log, writes suppressions. §23.7.
  "/inngest/email-soft-bounce-retry.ts",
  // #1611: Soft-bounce retry-content purge cron — deletes expired stored HTML (PII). §23.7.
  "/inngest/email-retry-content-purge.ts",
  // BP23: Resend webhook handler — writes email_log + suppressions outside user session. §23.7.
  "/app/api/webhooks/resend/route.ts",
  // #890: Resend INBOUND webhook — signature-only auth, resolves the tenant and
  // writes inbound_emails outside any user session. docs/design/inbound-persona-email.md.
  "/app/api/webhooks/resend-inbound/route.ts",
  // BP23: Unsubscribe endpoint — writes email_suppressions without user session. §23.3.
  "/app/api/email/unsubscribe/route.ts",
  // BP23: Companion page — reads pre_cruise_email_content via token, no user session. §23.5.
  "/app/companion/[token]/page.tsx",
  "/inngest/rag-normalize.ts",
  // BP24: Chat backend handler — drives anonymous + authenticated chat,
  // writes anonymous_chat_counters / customer_chat_counters / messages /
  // conversations / customer_memories before any user session exists for
  // the anonymous path. §24.
  "/app/api/chat/route.ts",
  // BP24: Anonymous chat counter cleanup cron — cross-tenant nightly. §24.8.
  "/inngest/anonymous-chat-counter-cleanup.ts",
  // BP24: Customer chat counter recompute cron — cross-tenant nightly. §24.9.
  "/inngest/customer-chat-counter-recompute.ts",
  // BP24: Deny-list quarterly review reminder cron — platform-wide. §24.5.
  "/inngest/denylist-quarterly-review-reminder.ts",
  // BP25: Retention crons — cross-tenant scans, no user session. §25.2.
  "/inngest/anonymous-session-cleanup.ts",
  "/inngest/rag-rejected-items-purge.ts",
  "/inngest/booking-commission-retention-purge.ts",
  // BP26: audit_log helper — every audit writer goes through this. §26.5.
  "/lib/audit/write.ts",
  // BP26: forensics_log retention cron — service-role daily purge. §26.5a.
  "/inngest/forensics-log-purge-cron.ts",
  // §26.5: audit_log 7-year retention cron — service-role daily purge.
  "/inngest/audit-log-retention-purge.ts",
  // BP26: §26.6 monitoring crons — cross-tenant scans, no user session.
  "/lib/cron/auth-failure-monitor.ts",
  "/lib/cron/permission-denied-monitor.ts",
  "/lib/cron/cross-tenant-rls-bypass-monitor.ts",
  // BP27: AI call wrapper — writes ai_call_log + UPSERTs tenant_usage_metrics
  // for every Anthropic/OpenAI call. Constructs its own service-role db. §27.12.
  "/lib/ai/call-wrapper.ts",
  // BP24: AI streaming wrapper — same governance as call-wrapper but with a
  // streaming lifecycle (text deltas during generation; cost/usage logged at
  // end). Constructs its own service-role db.
  "/lib/ai/stream-wrapper.ts",
  // BP27: abuse-monitoring crons + consumers — cross-tenant, no user session.
  "/inngest/ai-pricing-cache-refresh.ts",
  "/inngest/email-bounce-rate-monitor.ts",
  "/inngest/quality-low-approval-signal.ts",
  "/inngest/duplicate-high-rate-signal.ts",
  "/inngest/abuse-signal-consumers.ts",
  // BP22: Nightly tenant-approval-rate cron — cross-tenant scan. §22.11.
  "/inngest/rag-tenant-approval-rate-nightly.ts",
  // BP19 follow-on: the 5 group/invitation + auth-callback files that
  // previously read SUPABASE_SERVICE_ROLE_KEY directly now route through
  // createServiceRoleClient(). They're tenant-context callers (every
  // operation is filtered by ctx.tenant_id at the call site) but pre-date
  // the tenantClient proxy. Migrating to tenantClient is a follow-on.
  "/app/api/auth/callback/route.ts",
  // §17.2 — no-email recovery finalize. Same shape as the callback: the
  // user has just authenticated via OAuth but doesn't have a public.users
  // row yet, so RLS can't grant the upsert. Service-role with an explicit
  // (auth_user_id, tenant_id) upsert is the only path.
  "/app/api/auth/microsoft-email-verify/route.ts",
  // §7.1 / §17.3 — Tenant provisioning (signup/complete). Called on the
  // platform domain before any public.users or public.tenants row exists.
  // No tenant context → assertPermission can't run → service-role required
  // to INSERT the tenant and the first users row.
  // Two-layer isolation exception: tenant_id is the INSERT payload here,
  // not a filter target — no prior row exists to filter against.
  "/app/api/auth/signup/complete/route.ts",
  "/app/api/groups/route.ts",
  "/app/api/groups/[id]/invitations/route.ts",
  "/app/api/groups/invite/[token]/route.ts",
  "/app/api/groups/invite/[token]/rsvp/route.ts",
  // §19.x — anonymous invitee forum access (group-landing redesign PR6).
  // Shared checks 1-4 of the invite-token contract for the guest forum
  // routes below it — same public, session-less, HMAC-token-gated shape as
  // the two invite/rsvp routes directly above.
  "/lib/groups/invitation-token-checks.ts",
  // BP40 §40.5 — booking line items list/create.
  "/app/api/bookings/[id]/line-items/route.ts",
  // BP34: import pipeline (§34.3) — Inngest function with no user session.
  "/inngest/import-pipeline.ts",
  "/inngest/purge-parsed-documents.ts",
  "/app/api/webhooks/gmailpubsub/route.ts",
  // BP34: import intake routes — user-authenticated but helpers write cross-table.
  "/app/api/imports/manual/route.ts",
  "/app/api/imports/upload/route.ts",
  "/app/api/imports/review/route.ts",
  "/app/api/imports/review/[id]/accept/route.ts",
  "/app/api/imports/review/[id]/merge/route.ts",
  "/app/api/imports/review/[id]/reject/route.ts",
  // §34.3 retry: reset a parse_failed row + re-emit import.queued (mirrors the
  // sibling review routes, which manage import_queue via the service role).
  "/app/api/imports/review/[id]/retry/route.ts",
  "/app/api/imports/source-file/route.ts",
  "/app/api/integrations/gmail/health/route.ts",
  // BP37 task system.
  "/lib/cron/task-reminders-fire.ts",
  "/inngest/task-sequence-step-fire.ts",
  "/app/api/tasks/route.ts",
  // BP38 quote options.
  "/app/api/quotes/[id]/options/route.ts",
  "/app/api/quote-options/[id]/select/route.ts",
  "/app/api/public/quote/[token]/select/route.ts",
  // BP39 §39.2 / §39.3 — deliverable routes (cross-table reads + storage).
  "/app/api/bookings/[id]/itinerary/route.ts",
  "/app/api/bookings/[id]/resources/route.ts",
  "/app/api/itineraries/[id]/route.ts",
  "/app/api/resources/[id]/route.ts",
  // BP39 §39.2.6 — public tokenized itinerary viewer (no user session).
  "/app/i/[token]/page.tsx",
  // §38.4 — public tokenized quote viewer (no user session).
  "/app/q/[token]/page.tsx",
  // BP36 §36.6 — attribution_rollup nightly refresh + reports.
  "/inngest/attribution-rollup-refresh.ts",
  "/app/api/reports/leads-by-source/route.ts",
  "/app/api/reports/bookings-by-source/route.ts",
  "/app/api/reports/source-funnel/route.ts",
  "/app/api/reports/campaigns/route.ts",
  "/app/api/reports/first-vs-last-touch/route.ts",
  "/app/api/reports/cancellations/route.ts",
  // §12.4 — quote send route reads platform_settings + writes to quote-pdfs
  // bucket. Both require service-role; the route still gates on
  // assertPermission('quotes', 'send') for the tenant-user auth side.
  "/app/api/quotes/[id]/send/route.ts",
  // §12.4 / §38.5 — agent-facing PDF download. Same loader as /send
  // (loadQuoteRenderInput), which reads tenants and platform_settings
  // cross-tenant for tenant name + host_agency_legal_name. The quote
  // SELECT itself runs through tenantClient(ctx).
  "/app/api/quotes/[id]/pdf/route.ts",
  // §11.6 — pending-transfer + undo routes query anonymous_sessions which
  // is RLS-tenant-scoped. Both routes filter by tenant_id explicitly so
  // the service-role bypass restores no broader access than RLS would
  // grant a member.
  "/app/api/user/pending-transfer/route.ts",
  "/app/api/auth/transfer-session/route.ts",
  "/app/api/auth/transfer-session/preview/route.ts",
  "/app/api/auth/transfer-session/undo/route.ts",
  // §7.9 — Idempotency-Key middleware: reads/writes the cross-tenant
  // request_idempotency cache (locked down to service_role only via RLS).
  "/lib/http/idempotency.ts",
  // §7.9 — request_idempotency purge cron: background Inngest job, no
  // user session.
  "/inngest/request-idempotency-purge.ts",
  // #1590 — cross-tenant retention/pruning cron for fast-growing log/event
  // tables: background Inngest job, no user session.
  "/inngest/data-retention-purge.ts",
  // §38.8.1 / §39.5 — Token-gated public chat for quote view + trip
  // itinerary. Auth is the URL token; no user session. Resolves tenant
  // from the token's resource via service_role lookup, then runs the AI
  // call tenant-scoped. The /q and /i page surfaces are themselves
  // token-only.
  "/app/api/public/chat/[token]/route.ts",
  // §27.12 — AI batch reconciler cron: cross-tenant scan of
  // ai_batch_jobs + per-row writes to ai_batch_requests. Background
  // Inngest job, no user session.
  "/inngest/ai-batch-reconcile.ts",
  // §27.12 — AI batch flush cron: per-purpose batch submission.
  // Background Inngest job, no user session; service-role required to
  // read pending requests across tenants.
  "/inngest/ai-batch-flush.ts",
  // §11.2 / §27.12 — Memory-extraction batch producer/consumer:
  // ai_batch_requests writes are service-role-only RLS so the producer
  // can't use tenantClient. The consumer also writes back to
  // customer_memories using its own tenantClient via factory; the
  // service-role import here is scoped to enqueue + audit reads.
  "/inngest/extract-memory.ts",
  // #903 — Voice-profile extraction. tenantClient fetches samples (RLS-scoped);
  // service-role is used only for the voice_profiles upsert + stale-row delete,
  // which require a bypass of the voice_profiles UPDATE/DELETE RLS=false policies
  // (deletions go through service-role after app-layer ownership assertion, per
  // the D-091 two-layer pattern used throughout the codebase).
  "/inngest/extract-voice-profile.ts",
  // #903 — Voice sample deletion. RLS DELETE=false on voice_samples (service-role
  // only). App layer asserts ownership before calling service-role (D-091 two-layer).
  "/app/api/voice-profiles/samples/[id]/route.ts",
  // §23.4 — Open-Meteo embarkation forecast helper. Platform-scoped
  // (no tenant context): reads platform_settings + weather tables and
  // calls a public free-tier API. Service-role required because
  // weather_forecast_cache + weather_usage_metrics are RLS deny-all.
  "/lib/weather/open-meteo.ts",
  // §23.4 — Platform-admin weather usage + cap management endpoint.
  // Gated by assertPlatformAdmin; reads weather_usage_metrics +
  // platform_settings (both RLS deny-all) for the admin UI.
  "/app/api/admin/integrations/weather/route.ts",
  // §23.4 — Weather usage sustained-high operator alert cron. Background
  // job, no user session; reads platform-internal tables (RLS deny-all).
  "/inngest/weather-usage-alert.ts",
  // §TN — Travel news refresh cron: background Inngest job, no user session.
  // Fetches platform-level RSS feeds (news_feeds / news_articles have RLS
  // deny-all for authenticated; service_role is the only write path).
  "/inngest/travel-news-refresh.ts",
  // §23.1 / §23.7 — Template preview send: uses assertPermission (email_templates:write)
  // for auth + tenantClient for all reads (tenant-scoped). Service-role is scoped
  // only to the sendEmail call, which writes to email_log (RLS deny-INSERT for
  // authenticated). Explicit tenant_id filter applied at the call site. Same
  // email-send pattern as the groups invitation routes above.
  "/app/api/tenant/email-templates/[type]/send-preview/route.ts",
  // §TN — Travel news public ticker API: server-side fetch from news_articles
  // (RLS deny-all for authenticated; only service_role can read). No user
  // session required; response is public read-only.
  "/app/api/travel-news/route.ts",
  // BP36 §33.5 — CruiseMapper DIY static refresh cron: cross-tenant system
  // job (no user session) ingesting global reference content + pricing. Each
  // URL is processed in its own Inngest step.run (separate invocation), so one
  // withPlatformAdminAudit context can't span them — the job writes a single
  // platform-admin audit row per run and uses the service-role client for the
  // per-step work. §5.4.4.
  "/inngest/refresh-cruisemapper-static.ts",
  // #485 / §33.4 — CruiseMapper sailing refresh cron: same shape as the static
  // refresh above (cross-tenant system job, per-URL Inngest steps, one audit
  // row per run). §5.4.4.
  "/inngest/refresh-cruisemapper-sailings.ts",
  // §831 — CruiseMapper port backfill: event-triggered cross-tenant job, same
  // shape as refresh-cruisemapper-sailings (per-URL steps, service-role for
  // inventory reads/writes). §5.4.4.
  "/inngest/backfill-cruisemapper-ports.ts",
  // #781 Phase 2 Step 2 — cross-table backfill cron: reads/writes quote_options,
  // bookings, groups, price_watches as platform data (no tenant context). §5.4.4.
  "/inngest/backfill-cruise-fk.ts",
  // #965 — Branding setup banner server component: reads tenant_memberships
  // (role) and tenant_branding (logo_url) to decide whether to show the
  // banner. Both tables are RLS-gated to the tenant's own members, but this
  // component renders in the layout before page-level auth runs, so
  // tenantClient(ctx) has no resolved ctx to scope to. Reads are display-only;
  // errors return null (no throw). Two-layer isolation satisfied by explicit
  // .eq("tenant_id", tenantId) on both queries. Read-only.
  "/components/branding-setup-banner/BrandingSetupBannerServer.tsx",
  // #786 — Vendor health probe: 15-min Vercel cron that upserts durable status
  // to the platform-wide `vendor_health` table. No tenant context; service-role
  // is the only viable client. §5.4.4.
  "/lib/cron/vendor-health-probe.ts",
  // #786 — Vendor status admin page: reads from the platform-wide `vendor_health`
  // table. No tenant context (cross-vendor platform data); gated by AdminLayout
  // assertPlatformAdmin. Same pattern as supervisor/page.tsx. Read-only.
  "/app/(admin)/admin/vendor-status/page.tsx",
  // #712 — assertPermission PAT path: PAT token lookup + acting user lookup both
  // require service_role (personal_access_tokens has no authenticated PostgREST
  // policies; all access is service-role-only). The tenant isolation is enforced
  // app-layer: patRow.tenant_id === middleware-resolved tenantId. §7.9 / §26.2.
  "/lib/auth/assert-permission.ts",
  // #712 — PAT token list + create routes: personal_access_tokens has no
  // authenticated PostgREST policies. Tenant isolation enforced by explicit
  // .eq("tenant_id", ctx.tenant_id) + assertPermission. §7.9 / §26.2.
  "/app/api/integrations/tokens/route.ts",
  "/app/api/integrations/tokens/[id]/route.ts",
];
