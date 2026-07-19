# PII data-map: nested-PII review of the 12 flagged JSONB container columns

Tracks issue #2011 (Harvey M10 schema-tier audit, 2026-07-18 engagement). The
audit's schema classifier flagged 12 JSONB/JSON container columns on the main
DB as "may nest PII, needs human confirmation" — it did not assert PII and did
not sample row data (no `execute_sql` access under the engagement scope).

## Method

For each column: grepped the repo for every writer and reader (`.from("<table>")`,
route handlers, Inngest functions, validation schemas) to determine the actual
JSONB shape from code, not row samples. Cross-referenced against:

- `apps/main/supabase/migrations/*.sql` for the table's RLS policies and grants.
- `apps/main/src/lib/privacy/purge-user-data.ts` — the CCPA/§25.4 user-erasure
  flow (`purgeUserDataPerRetention`).
- `apps/main/src/inngest/data-retention-purge.ts` — the general TTL-purge cron
  and its `DELETE_TARGETS` table list.
- `apps/main/src/inngest/user-data-export-build.ts` — the CCPA data-export
  flow (`collectUserDbExport`).
- `apps/main/src/lib/db/tenant-scoped-tables.ts` — the `tenantClient` isolation
  registry.

No row data was sampled (this is a schema + code review, not a live-DB probe)
— consistent with the source audit's own scope limitation, and with the
"prefer schema/code analysis" guidance for this kind of review.

## Per-column review

### 1. `users.notif_preferences`

| | |
|---|---|
| **Schema** | `JSONB DEFAULT '{}'::jsonb`, nullable-by-default-empty. `apps/main/supabase/migrations/20260521120000_tenancy_and_identity.sql:120`. |
| **What's inside** | **No writer exists anywhere in current app code.** Grepped the whole repo for `notif_preferences` / `notifPreferences`: the only non-migration hit is a read in `apps/main/src/inngest/user-data-export-build.ts:46` (the CCPA export column allowlist). No route, Inngest function, or settings page ever sets this column — every row holds the schema default `{}`. |
| **PII classes present** | None currently (column is always empty in practice). If a future writer lands (e.g. a notification-channel opt-in that stores a phone number or alternate email), that would introduce PII. |
| **RLS / tenant scoping** | `users` table: full 4-policy tenant-scoped RLS (`apps/main/supabase/migrations/20260521120002_tenants_users_rls.sql:45-68`), `auth_user_in_tenant(tenant_id)`. Covered. |
| **Retention / erasure** | Included in the CCPA export (`collectUserDbExport`). **NOT** nulled by the CCPA purge (`purge-user-data.ts` Step 8 clears `email/phone/first_name/last_name/display_name` but not `notif_preferences`). |
| **Logs / exports exclusion** | N/A — nothing writes to it, so nothing to leak. |
| **Finding** | **Minor/dormant gap.** No PII exposure today (column is unwritten), but the purge step doesn't defensively null it, so if a writer is added later without also touching `purge-user-data.ts`, purged users would retain notification-preference data indefinitely. See follow-up 1. |

### 2. `pending_rag_sync.payload`

| | |
|---|---|
| **Schema** | Table **no longer exists.** `DROP TABLE IF EXISTS public.pending_rag_sync;` — `apps/main/supabase/migrations/20260722000019_contract_drop_pending_rag_sync_and_promoting.sql`. That migration's own commit note confirms: PR #1819 moved RAG tenant-event delivery to Inngest (`rag-sync-deliver.ts`), the table had zero writers/readers left, and any pre-cutover undelivered rows were healed by the nightly RAG reconcile before the drop. |
| **What's inside** | N/A — table dropped. Remaining hits for the string `pending_rag_sync` in `apps/main/src/inngest/rag-sync-deliver.ts`, `events.ts`, `lib/rag-sync/publish-tenant-event.ts`, `lib/rag-sync/publish-chunk-feedback.ts` are all historical code comments, not live references (`.from("pending_rag_sync")` does not appear anywhere in app code). |
| **PII classes present** | N/A |
| **RLS / tenant scoping** | N/A — no table |
| **Retention / erasure** | N/A — no table |
| **Finding** | **Verified-clean / stale flag.** This is a non-issue: the audit's schema scan or its snapshot of the migration history flagged a column from a table the codebase already contracted away. Nothing to review, no action needed. |

### 3. `customer_memories.preferences`

| | |
|---|---|
| **Schema** | `JSONB`, one of eight sibling memory-fields on the row (`travel_history`, `family_composition`, `accessibility_needs`, `dietary_restrictions`, `loyalty_programs`, `important_dates` also exist but are separate columns not in this issue's 12). `apps/main/supabase/migrations/20260523180000_customer_memories.sql`. |
| **What's inside** | AI-extracted, free-form (`z.record(z.unknown())` in `apps/main/src/inngest/extract-memory.ts:62`) general travel preferences pulled from conversation content by the memory-extraction batch job. The extraction prompt explicitly separates PII-bearing fields (names → `family_composition`, loyalty numbers → `loyalty_programs`, DOBs → `important_dates`) from `preferences`, which is scoped to non-identity facts (e.g. cabin type, dining time, quiet-cabin request). Because it's LLM-extracted free text, incidental PII leakage into this field can't be fully ruled out from code alone, but it is not the field the system designs to hold identity data. |
| **PII classes present** | Low/incidental — travel preference facts; not designed to carry names/DOB/loyalty numbers (those have dedicated sibling columns). |
| **RLS / tenant scoping** | Full 4-policy tenant-scoped RLS (`customer_memories_tenant_select/insert/update/delete`, `auth_user_in_tenant(tenant_id)`). Also registered in `TENANT_SCOPED_TABLES`. Two-layer isolation confirmed. |
| **Retention / erasure** | **Fully covered.** `purge-user-data.ts` Step 4 (Category 2) `DELETE`s the entire `customer_memories` row for the purged `user_id` — `preferences` and all sibling JSONB fields are deleted, not just nulled. |
| **Logs / exports exclusion** | Not included in the CCPA export allowlist (`collectUserDbExport` only pulls `users`/`conversations`/`bookings`/`legal_consents`) — reasonable, since the row is deleted outright on erasure and memory data isn't currently in the export scope. |
| **Finding** | **Verified-clean.** RLS, tenant isolation, and erasure coverage are all in place. |

### 4. `ai_batch_requests.caller_metadata`

| | |
|---|---|
| **Schema** | `JSONB` (nullable). `apps/main/supabase/migrations/20260528000001_ai_batches.sql`. |
| **What's inside** | Producer-supplied context, purpose-specific. Confirmed shapes across the 5 producers: `extract-memory.ts` → `{ tenant_id, conversation_id, user_id }`; `rag-pii-redact.ts` → `{ submission_id, ... }`; `persona-addendum-rescreen-nightly.ts` → `{ addendum_id, persona_slug }`; `persona-addendum-screen.ts` → `{ addendum_id }`; `precruise-generate-and-send.ts` → `{ booking_id, phase, companion_page_url }`. All values are internal UUIDs/enums/URLs used to route the batch result back to its side-effect handler — no raw names, emails, phones, DOBs, or free text. |
| **PII classes present** | Indirect identifiers only (UUID foreign keys to PII-bearing rows elsewhere: `user_id`, `booking_id`, `conversation_id`). No literal PII values. |
| **RLS / tenant scoping** | `ai_batch_requests`: RLS enabled, single policy `FOR ALL USING (auth.role() = 'service_role')` — service-role only, no user JWT path exists to this table at all (not in `TENANT_SCOPED_TABLES` or `PLATFORM_READABLE_TABLES`; never reached via `tenantClient`). |
| **Retention / erasure** | No purge cron for this table (not in `data-retention-purge.ts`). `caller_metadata.user_id` for a CCPA-purged user is **not** scrubbed — the UUID reference persists in this internal pipeline table after the user's `users` row is anonymized. |
| **Logs / exports exclusion** | Not in the CCPA export allowlist. Correct — this is an internal-only table. |
| **Finding** | **Low-severity gap.** No direct PII, but `caller_metadata.user_id` is an unscrubbed reference to a purged user that persists indefinitely in a table with no retention policy. Practical risk is low (service-role-only access, no display surface), but it's inconsistent with the purge flow's stated intent. See follow-up 2. |

### 5. `ai_batch_requests.result_metadata`

| | |
|---|---|
| **Schema** | `JSONB` (nullable), populated only on `status='completed'`. |
| **What's inside** | Confirmed in `apps/main/src/lib/ai/batch/reconcile.ts:281-286`: exactly `{ model, input_tokens, output_tokens, stop_reason }` — Anthropic usage/billing metadata. The actual AI output text goes to the separate `result_text` TEXT column (not JSONB, not in this issue's scope). |
| **PII classes present** | None. |
| **RLS / tenant scoping** | Same as `caller_metadata` above — service-role-only. |
| **Retention / erasure** | No purge cron (same as above), but no PII to purge. |
| **Finding** | **Verified-clean.** Structurally incapable of carrying PII — it's a fixed 4-key token/cost-accounting object. |

### 6. `weather_forecast_cache.payload`

| | |
|---|---|
| **Schema** | `JSONB NOT NULL`, keyed on `(port_id, forecast_date)`. `apps/main/supabase/migrations/20260530120000_weather_forecast_cache.sql`. |
| **What's inside** | Confirmed in `apps/main/src/lib/weather/open-meteo.ts`: the raw Open-Meteo API response (`WeatherForecast` type) — temperature, precipitation, wind, weather codes for a port/date. No customer data of any kind; the table isn't keyed to a user or tenant at all. |
| **PII classes present** | None — third-party weather data only. |
| **RLS / tenant scoping** | Explicit deny-all policies for `authenticated` (`FOR SELECT/INSERT/UPDATE/DELETE USING (FALSE)`), service-role only. Table has no `tenant_id` column by design (platform-shared cache). |
| **Retention / erasure** | No purge cron — the migration's own comment notes TTL is enforced at read-time (app compares `fetched_at` against a 6h window) rather than by deletion, so rows accumulate forever. Not a PII issue (no PII present), but flagged as an unbounded-growth hygiene note, not a compliance gap. |
| **Finding** | **Verified-clean** for PII purposes. Unbounded table growth is a storage-hygiene observation, not a PII/erasure gap (out of this issue's scope; not filed as a follow-up since it carries no personal data). |

### 7. `group_invite_pending_approval.payload`

| | |
|---|---|
| **Schema** | `JSONB NOT NULL`. `apps/main/supabase/migrations/20260606000000_abuse_monitoring.sql:284-299`, described as the "soft2 admin-preapproval queue" for group invites that exceed the tenant's `group_invite` abuse threshold. |
| **What's inside** | **No INSERT into this table exists anywhere in the codebase.** Grepped every reference: `apps/main/src/lib/groups/delete-group.ts:27` only `DELETE`s rows on group teardown; `apps/main/src/app/api/groups/route.ts` only mentions the table name in a comment about delete-ordering; `tenant-scoped-tables.ts` only registers it for isolation. The group-creation flow (`POST /api/groups`) inserts directly into `invitations` (which does carry `invitee_email`/`invitee_name`/`personal_note`) regardless of the tenant's `group_invite_limit_state` — there is no code path that ever routes an invite through this approval queue. `payload` has never held data in any deployed build. |
| **PII classes present** | None currently (column is never written). If/when the soft2 gate is implemented, `payload` would presumably carry the same invitee email/name/personal-note shape as `invitations`, since that's the data being gated. |
| **RLS / tenant scoping** | Explicit deny-all for `authenticated` on all 4 operations, service-role only. Registered in `TENANT_SCOPED_TABLES`. Would be adequately isolated if used. |
| **Retention / erasure** | Rows are deleted on group hard-delete (`delete-group.ts`) but there's no TTL and no CCPA-purge touch — moot today since nothing is ever inserted. |
| **Finding** | **Not a PII gap** (nothing is ever stored), but a genuine **product-completeness gap**: the "soft2 admin-preapproval queue" described in the schema comment and referenced by `group_invite_limit_state` tracking (`apps/main/src/lib/abuse/state-machine.ts`, `thresholds.ts`) was never wired to the invite-creation path — it's a dead scaffold. Flagged per the repo's never-ignore-a-bug rule as a follow-up (not a security bug, but an abandoned enforcement mechanism worth a decision: implement or remove). See follow-up 3. |

### 8. `bug_submissions.browser_info`

| | |
|---|---|
| **Schema** | `JSONB` (nullable). `apps/main/supabase/migrations/20260608000000_self_service_help.sql:39`. |
| **What's inside** | Confirmed in `apps/main/src/app/api/help/bugs/route.ts:44`: strictly typed `{ browser?: string; os?: string; viewport?: string }` — auto-detected client environment info (e.g. "Chrome", "macOS", "1920x1080"), captured by the Help-AI flow (`lib/help-ai/flow-controller.ts`) and surfaced verbatim into the auto-filed GitHub issue body (`lib/github/issues.ts:128-130`). |
| **PII classes present** | None — browser/OS/viewport strings are not personal identifiers (no IP address, no device fingerprint/UA string, no user-agent header capture found). |
| **RLS / tenant scoping** | Full 4-policy tenant-scoped RLS (registered in `TENANT_SCOPED_TABLES`). The row also carries `submitter_user_id` and PII-adjacent free-text fields (`actual_behavior`, `steps_to_reproduce`) which the schema comment states are "redacted of PII per §32.7.6" by the Help AI — those fields are outside this issue's 12-column scope but share the same RLS coverage. |
| **Retention / erasure** | `bug_submissions` is **explicitly exempted** from the `data-retention-purge` cron, with the comment: "governed by the submission lifecycle, not this sweep." Grepped for any lifecycle-based deletion of `bug_submissions` rows (closed_at-triggered purge, admin cleanup route, etc.) — **none exists**. Rows persist indefinitely regardless of `closed_at`/`triage_state`. |
| **Finding** | **`browser_info` itself is verified-clean** (no PII in this column). Separately, the retention-cron's inline comment describes a lifecycle-governed retention for the table that doesn't actually exist in code — a documentation/implementation mismatch. Since `browser_info` carries no PII, this isn't filed as a PII-erasure gap for this issue, but is worth a low-priority follow-up given the table does have other PII-adjacent columns riding on the same (absent) retention story. See follow-up 4. |

### 9. `pricing_cache.raw_payload`

| | |
|---|---|
| **Schema** | `JSONB NULL`. `apps/main/supabase/migrations/20260611000000_pricing_cache.sql`. Migration comment: "RLS DELIBERATELY DISABLED — only the Apify adapter (service-role) reads and writes this table... pricing is reference data, not tenant-owned." |
| **What's inside** | **No writer sets this column.** The only insert/upsert path (`apps/main/src/lib/pricing/pricing-cache.ts:upsertPriceQuote`, called from `apps/main/src/lib/pricing/apify-pricing-adapter.ts`) constructs rows with exactly `{ cruise_line, ship, sail_date, departure_port, duration_nights, cabin_class, price_amount, price_currency, fetched_at, source }` — `raw_payload` and `actor_run_id` are both omitted from every write. The column is always `NULL` in practice. |
| **PII classes present** | None currently (unwritten). If ever populated, it would hold cruise-line pricing-page scrape output — commercial pricing data, not customer PII, given the adapter's scope (§33.2/33.3 per-cruise-line price scraping). |
| **RLS / tenant scoping** | RLS is disabled by design (documented exception in `db/rls-exceptions.txt` per the migration comment) — platform-shared reference table, no tenant dimension, service-role-only access path (registered in `PLATFORM_READABLE_TABLES`, not user-reachable). |
| **Retention / erasure** | No purge cron; not applicable — no PII, and the table is a shared reference cache, not user data. |
| **Finding** | **Verified-clean.** No PII risk: the column is dormant, and even if populated it's scoped to commercial pricing data by the adapter's design, not customer information. |

### 10. `gmail_inbound_messages.raw_payload`

| | |
|---|---|
| **Schema** | `JSONB` (nullable). `apps/main/supabase/migrations/20260617000000_bp34_phase_c_gmail_storage.sql:71`. |
| **What's inside** | Confirmed in `apps/main/src/app/api/webhooks/gmailpubsub/route.ts:157`: `raw_payload: msg.value` — the **full raw Gmail message resource** returned by the Gmail API (headers, MIME structure, base64 body parts, attachment metadata). The same row also stores `from_email`, `to_email`, `subject`, `body_text`, `body_html` as separate plaintext columns. This is confirmed high-PII, matching the issue's own flag — it's the tenant's persona inbox, so any customer who emails the tenant has their name, email address, and full message content captured here. |
| **PII classes present** | **High** — email addresses, names (from display-name headers / signatures), free-text message bodies that can carry anything (phone numbers, booking details, occasionally payment/passport info a customer pastes into an email). |
| **RLS / tenant scoping** | `SELECT` policy scoped to `auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id)` for `authenticated`; `GRANT SELECT` to `authenticated`, full CRUD to `service_role`. **Gap:** unlike `inbound_emails` and every other table reviewed here, this table has **no explicit deny policies for INSERT/UPDATE/DELETE** — it relies on the absence of a `GRANT INSERT/UPDATE/DELETE TO authenticated` rather than an explicit `WITH CHECK (FALSE)` policy. Functionally equivalent (no grant ⇒ no access regardless of policy), but it's an inconsistency against this repo's own §30.8 migration-lint convention ("don't rely on 'no policy = deny'") that every sibling table in this review follows explicitly. |
| **Retention / erasure** | **Real gap.** Not present in `data-retention-purge.ts`'s `DELETE_TARGETS` list (which does cover the outbound analog, `email_log`, at 365 days) — no TTL, no purge cron anywhere. Also **not reachable by the CCPA erasure flow**: `purge-user-data.ts` never queries `gmail_inbound_messages`. Because rows are keyed by the tenant's Gmail persona (not by `users.id`), there is no code path that would ever null/delete a specific customer's emails here, even after that customer completes a full CCPA deletion request via `/api/user/data/delete-request`. |
| **Logs / exports exclusion** | No console logging of `raw_payload`/`msg.value` found in the webhook handler or `process-gmail-message.ts`. The import pipeline (`import-pipeline.ts:resolveText`) only reads `body_text`, never `raw_payload`, when composing downstream content. Good practice already in place. |
| **Finding** | **Real gap** — both flagged by the issue as expected, and confirmed by code: no retention TTL and no CCPA-erasure reachability for a table that structurally contains customer email content. Minor secondary finding: missing explicit deny-policies for non-SELECT ops (defense-in-depth, not currently exploitable). See follow-up 5. |

### 11. `booking_line_items.item_details`

| | |
|---|---|
| **Schema** | `JSONB` (nullable). `apps/main/supabase/migrations/20260623000000_bp40_non_cruise_line_items.sql:36`. |
| **What's inside** | Confirmed in `apps/main/src/app/api/bookings/[id]/line-items/route.ts` and `apps/main/src/app/api/line-items/[id]/route.ts`: accepted via Zod as `z.record(z.unknown())` — **entirely unconstrained** at the API boundary. `apps/main/src/lib/line-items/validate.ts` only applies light structural checks for two of the six `item_type`s: `flight` requires `depart_airport`/`arrive_airport` present, `hotel` requires `hotel_name` present (airport codes and hotel names are not PII). `transfer`, `excursion`, `insurance`, and `other` have **no structural checks at all** ("No additional structured checks in v1"). |
| **PII classes present** | None observed in the validated fields (airport codes, hotel names). **Potential** — because the field is a free-form `Record<string, unknown>` accepted from any tenant-agent caller with no allowlist, nothing at the application layer prevents an agent from putting a passenger name, DOB, or policy number into an `insurance`/`other` item's `item_details` blob. No evidence in code that this currently happens, but no evidence it's prevented either. |
| **RLS / tenant scoping** | Full 4-policy tenant-scoped RLS (`bli_select/insert/update/delete`, `auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id)`). Registered in `TENANT_SCOPED_TABLES`. Two-layer isolation confirmed. |
| **Retention / erasure** | `booking_line_items` has no `user_id` column (only `tenant_id`/`booking_id`) and is **not touched at all** by `purge-user-data.ts` — the CCPA purge anonymizes `bookings` (nulls `user_id`, stamps `anonymized_customer_hash`) and `commissions`, but never visits `booking_line_items`. Because there's no direct FK to the purged user, the row's link to the customer is already broken once `bookings.user_id` is nulled — so as long as `item_details` never stores customer-identifying data directly (matching its designed purpose as supplier/logistics detail), this is adequate coverage. If the free-form risk above is ever realized, though, that PII would survive the purge untouched. |
| **Finding** | **Moderate gap, contingent.** No confirmed PII in current data, but the column is structurally capable of it (unconstrained free-form JSON, no schema, no redaction, no erasure reach) and there is no code-level guarantee it stays that way. This is the kind of "free-text that can carry anything" case the issue asked to flag explicitly. See follow-up 6. |

### 12. `inbound_emails.raw_payload`

| | |
|---|---|
| **Schema** | `JSONB NOT NULL`. `apps/main/supabase/migrations/20260709143339_inbound_emails.sql`. |
| **What's inside** | Confirmed in `apps/main/src/app/api/webhooks/resend-inbound/route.ts:172`: `raw_payload: event.data` — the full Resend `email.received` webhook payload (from/to/subject/body/headers/SPF-DKIM verdicts). The row also stores `from_email`, `to_email`, `subject`, `text_body` as separate plaintext columns, same pattern as `gmail_inbound_messages`. This is the reply channel for persona addresses (marcus@ai-travelconcierge.com etc.) — any customer replying to a tenant's persona has their email address, display name, and message body captured here, matching the issue's high-PII flag. |
| **PII classes present** | **High** — email addresses, names, free-text message bodies (same class of risk as #10). |
| **RLS / tenant scoping** | Explicit, complete RLS: `SELECT` policy requires `auth.uid() IS NOT NULL AND tenant_id IS NOT NULL AND auth_user_in_tenant(tenant_id)` (unresolved rows with `tenant_id IS NULL` are invisible to all tenant users by construction); explicit `WITH CHECK (FALSE)` / `USING (FALSE)` deny policies for INSERT/UPDATE/DELETE. This table follows the §30.8 explicit-deny convention correctly (contrast with #10's gap). Unresolved rows are reachable only via the platform-admin route (`withPlatformAdminAudit`, service-role). Well-covered. |
| **Retention / erasure** | **Real gap**, same shape as #10. Not in `data-retention-purge.ts`'s `DELETE_TARGETS`. Not visited by `purge-user-data.ts` — a customer's CCPA deletion request never reaches `inbound_emails`, even though `from_email`/`text_body`/`raw_payload` for that customer's own reply would persist indefinitely. |
| **Logs / exports exclusion** | **Good practice confirmed.** The platform-admin list route (`apps/main/src/app/api/admin/inbound-emails/route.ts`) explicitly selects a metadata-only column list (`id, provider_message_id, tenant_id, contact_id, from_email, to_email, subject, resolution, spf_result, dkim_result, forwarded_email_log_id, received_at`) — `raw_payload` and `text_body` are deliberately excluded from the admin listing, matching the route's own comment ("metadata only, no bodies"). |
| **Finding** | **Real gap** on retention/erasure (identical shape to #10), but RLS and log/export hygiene are both done correctly here — this table should be the reference pattern when fixing #10's RLS gap. See follow-up 5 (shared with #10 — same fix pattern applies to both tables). |

## Findings summary

| # | Column | Verdict |
|---|---|---|
| 1 | `users.notif_preferences` | Dormant gap — unwritten today, purge doesn't null it defensively |
| 2 | `pending_rag_sync.payload` | **Verified-clean** — table dropped, non-issue |
| 3 | `customer_memories.preferences` | **Verified-clean** |
| 4 | `ai_batch_requests.caller_metadata` | Low-severity gap — unscrubbed `user_id` reference on purge |
| 5 | `ai_batch_requests.result_metadata` | **Verified-clean** |
| 6 | `weather_forecast_cache.payload` | **Verified-clean** (no PII; unbounded growth is out of scope) |
| 7 | `group_invite_pending_approval.payload` | Not a PII gap — dead scaffold, never written |
| 8 | `bug_submissions.browser_info` | **Verified-clean** for this column; table-level retention story is undocumented-vs-code |
| 9 | `pricing_cache.raw_payload` | **Verified-clean** — dormant, never written |
| 10 | `gmail_inbound_messages.raw_payload` | **Real gap** — no retention TTL, no CCPA-erasure reach; minor RLS-policy-explicitness gap |
| 11 | `booking_line_items.item_details` | Moderate gap — unconstrained free-form field, no erasure reach if PII lands there |
| 12 | `inbound_emails.raw_payload` | **Real gap** — no retention TTL, no CCPA-erasure reach (RLS/log-hygiene are done correctly) |

The two columns the source audit called out as "highest-likelihood PII/PHI carriers" (#10, #12) are confirmed as such, and both share the same real gap: **customer email content received on persona addresses has no retention TTL and is not reachable by the CCPA user-erasure flow**, even though a customer's own reply is exactly the kind of self-submitted PII CCPA erasure is meant to cover.

## Follow-ups (to be filed as GitHub issues by the supervisor)

1. **`users.notif_preferences` not nulled by CCPA purge.**
   File: `apps/main/src/lib/privacy/purge-user-data.ts` (Step 8, ~line 300-316).
   Acceptance: add `notif_preferences: null` (or `{}`) to the Step 8 `users` update alongside the existing PII-clearing fields, defensively, even though no writer currently populates the column — so the purge stays correct the moment a writer lands. Low priority; no current exposure.

2. **`ai_batch_requests.caller_metadata` retains a `user_id` reference after CCPA purge.**
   File: `apps/main/src/lib/privacy/purge-user-data.ts`; also `apps/main/src/lib/ai/batch/reconcile.ts`, `apps/main/src/inngest/extract-memory.ts`.
   Acceptance: decide whether to (a) scrub `caller_metadata.user_id` for completed/failed batch rows tied to a purged user as part of the purge flow, or (b) explicitly document that this internal pipeline table is out of CCPA erasure scope (service-role-only, no display surface, short natural lifespan) and why. Low severity — no direct PII, just an unscrubbed FK-shaped UUID.

3. **`group_invite_pending_approval` "soft2 admin-preapproval queue" is a dead scaffold.**
   File: schema in `apps/main/supabase/migrations/20260606000000_abuse_monitoring.sql`; intended trigger point in `apps/main/src/app/api/groups/route.ts` and `apps/main/src/lib/abuse/state-machine.ts`.
   Acceptance: decide whether to implement the soft2 gate (group invites pause for admin approval once `group_invite_limit_state` reaches `soft2`, with `payload` carrying the pending invitee list) or remove the unused table/RLS/indexes. If implemented, `payload`'s PII (invitee email/name/personal_note, same shape as `invitations`) needs RLS + erasure coverage matching `invitations`'s pattern at that time. Not a security bug today — flagged per the repo's never-ignore-a-bug rule since it's an abandoned enforcement mechanism discovered during this review, not a PII issue itself.

4. **`bug_submissions` retention-cron comment doesn't match code.**
   File: `apps/main/src/inngest/data-retention-purge.ts` (comment at top, "governed by the submission lifecycle, not this sweep"); no lifecycle purge found anywhere for `bug_submissions`/`feature_requests`.
   Acceptance: either implement a `closed_at`/`triage_state`-based purge for `bug_submissions`/`feature_requests` (mirroring the pattern used for other tables in this cron), or correct the comment to state that these tables are intentionally retained indefinitely and why. Low priority — `browser_info` itself carries no PII, but the table's other columns (`submitter_user_id`, free-text fields) do ride on this same absent retention story.

5. **`gmail_inbound_messages` and `inbound_emails`: no retention TTL, not reachable by CCPA erasure.**
   Files: `apps/main/src/inngest/data-retention-purge.ts` (add both tables to `DELETE_TARGETS`, or a dedicated cron mirroring `email-retry-content-purge.ts`'s pattern); `apps/main/src/lib/privacy/purge-user-data.ts` (add a step that finds rows where `from_email`/`to_email` matches the purged user's email and nulls/deletes the PII-bearing columns, similar to the existing Category-1/Category-3 pattern).
   Also fold in the minor secondary finding: add explicit `WITH CHECK (FALSE)`/`USING (FALSE)` deny policies for INSERT/UPDATE/DELETE on `gmail_inbound_messages` to match `inbound_emails`'s pattern and the repo's §30.8 explicit-deny convention (currently relies on grant-absence only — functionally safe today, but inconsistent).
   Acceptance: both tables get a retention window (recommend matching or shorter than `email_log`'s 365 days, since these carry full bodies not just metadata), and the CCPA purge flow reaches any row where the purged user's own email address appears as sender or recipient. This is the highest-priority follow-up from this review — it's a genuine PII-erasure gap on the two columns the source audit specifically called out as highest-risk.

6. **`booking_line_items.item_details` is unconstrained free-form JSON with no erasure reach.**
   Files: `apps/main/src/lib/line-items/validate.ts` (add per-type key allowlists for `transfer`/`excursion`/`insurance`/`other`, matching the existing `flight`/`hotel` pattern); `apps/main/src/app/api/bookings/[id]/line-items/route.ts` and `apps/main/src/app/api/line-items/[id]/route.ts` (the `z.record(z.unknown())` schema).
   Acceptance: either constrain `item_details` to a documented per-`item_type` key schema that structurally excludes customer-identity fields (names, DOB, passport/loyalty numbers — those belong on `contacts`/`booking_passengers`, not a supplier-logistics blob), or explicitly document that `item_details` is supplier/commercial data only and add a lightweight validation guard that rejects known PII-shaped keys. No confirmed PII in current data — this is a preventive/contingent gap, not an active leak.
