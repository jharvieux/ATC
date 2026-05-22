# Build Prompts — Spec v6.2, Part 5 (Sections 19–24)

## How Part 5 builds on Parts 1–4

Part 5 takes the platform from “sub-host can take a booking and pay a sub-host” (the end-state of Part 4) to a **fully operating AI-mediated customer experience**. By the end of Part 5:

- Active groups can hold forum-style asynchronous threaded conversation, with every message going through Haiku moderation under a strict fail-closed contract: when Haiku is unavailable the messages enter `pending_moderation`, distinct from the coordinator’s `flagged_review` queue, retried on 5/15/60 minute backoff, and escalated to the coordinator after 24 hours if Haiku never returns.
- The platform’s booking schema is in place — every booking captures DOB-not-ages, estimated-DOB confirmation gates, multi-traveler contact creation, sub-host tenant-of-record disclosure, and the no-anonymous-bookings rule — even though the final booking UI is deferred until a launch host is chosen.
- Chat conversations are RAG-grounded with entity extraction, confidence-floor filtering, knowledge block injection with explicit authority/recency/match metadata, inline citation, freshness caveats for time-sensitive content, and the full **eight-layer hallucination defense** running on every assistant turn. The “real” preflight checks left as stubs in Build Prompt 11 are now implemented.
- Quote PDFs render with the §21.10.1 “estimate vs confirmed” discipline, the customer-authorized variance is recorded at acceptance, and the booking-submit handler pauses to `pending_customer_reconfirmation` when the host’s actual price lands outside the customer’s authorized variance.
- The full RAG ingestion pipeline is live: web UI single-item submit, browser extension, iOS Shortcut, file uploads (PDF/DOCX/XLSX/PPTX/TXT/MD/HTML/JPG/PNG), manual entry, batch API. Content flows through extraction → PII redaction with zero-tolerance quarantine and 24-hour alert aggregation → Haiku normalization → tenant review → optional global promotion via the revised model where platform admin can promote any tenant chunk under the perpetual irrevocable license accepted at signup.
- Email infrastructure is live with Resend for outbound, the email_log + suppressions tables, full CAN-SPAM compliance, and the pre-cruise email series (T-90, T-30, T-7, T-1) generating per-customer cached content with the T-1 carry-on essentials callout and the port-information RAG seed for 17 North American departure ports.
- The customer-facing chat UI ships with the persistent AI disclosure banner, streaming with cursor-aware auto-scroll, the five-level tone-matching scale with topic-aware modulation and customer override, the supervisor `tone_drift` check’s heuristic layer plus the **deterministic hate-speech deny-list** that no tenant config can weaken, the three-identifier anonymous chat rate limit (session / IP / fingerprint), and the three-tier authenticated customer rate limit (Soft1 / Soft2 / Hard) with booking-bonus capacity, in-character persona-prompt augmentation at soft tiers, and a platform-spoken system message at the hard limit.

All five prompts assume Build Prompts 01–19 from Parts 1–4 are committed. Each prompt names the spec sections it depends on.

-----

## Prerequisites added by Part 5

These extend the earlier prerequisites lists. None of this is code work; line them up before Build Prompt 20.

### 1. New cloud services and external dependencies

|Service|What you need|Used in Part 5 sections|
|---|---|---|
|**Resend (verified)**|Already provisioned in Part 4 Prompt 18 for tenant emails. Confirm domain DKIM/SPF is verified; confirm webhook is hitting `/api/webhooks/resend` for bounce/complaint events.|§23 throughout|
|**OCR provider**|For scanned PDF and image submissions. Choose: bundled Tesseract via `tesseract.js` (free, lower quality) or Google Cloud Vision API (paid, higher quality). Document choice in MEMORY.|§22.3, §22.4|
|**File parsers**|`pdf-parse` for PDF; `mammoth` for DOCX; `SheetJS` for XLSX; a PPTX reader (`officegen`-based or `pptxgenjs` reader); `cheerio` for HTML.|§22.3|
|**Image generation API (already chosen in Part 4)**|Either Replicate (SD XL) or OpenAI (DALL-E 3). Pre-cruise emails use this for destination imagery if no library hit.|§23.4|
|**Google Pub/Sub (optional, deferred-launch)**|For Gmail inbound per §23.9. Tenant-opt-in; not blocking launch.|§23.9|

### 2. New keys to add to env before Build Prompt 20

```
HAIKU_FORUM_MODERATION_MODEL (default 'claude-haiku-4-5-20251001')
HAIKU_NORMALIZATION_MODEL (default 'claude-haiku-4-5-20251001')
HAIKU_PII_REDACTION_MODEL (default 'claude-haiku-4-5-20251001')
ENTITY_EXTRACTION_MODEL (default 'claude-haiku-4-5-20251001')
RAG_INGEST_MAX_FILE_SIZE_BYTES (default 52428800 — 50MB)
RAG_INGEST_OCR_PROVIDER (one of: 'tesseract' | 'gcv')
GCV_API_KEY (only if RAG_INGEST_OCR_PROVIDER='gcv')
QUOTE_PDF_RENDERER (one of: 'puppeteer' | 'react-pdf' — operator choice; see Part 3 deferred-from Prompt 13)
```

### 3. Decisions to make before Build Prompt 20

- **Booking flow path.** Spec §20 explicitly says the booking UI is deferred for final design until a launch host is selected; the platform-native flow described is a fallback reference design. **Build Prompt 20 ships the schema + the platform-native reference UI as a stub** so the rest of Part 5 can keep moving. Once a host is chosen and a decision is made (host widget vs native flow), Build Prompt 20’s `/booking/flow/*` pages either get replaced with an iframe wrapper or get filled out. Confirm this approach before running Prompt 20.
- **OCR provider.** Tesseract (in-process, free, slower) vs Google Cloud Vision (paid API, better with scans). Pick before Prompt 22.
- **Quote PDF renderer.** Puppeteer/Chromium produces flexible HTML→PDF but adds a Vercel function size constraint; `react-pdf` is leaner but more limiting on layout. Pick before Prompt 21.
- **Slur deny-list initial content.** Per Build Prompt 11 the list was created empty. Build Prompt 24 needs the list populated before launch. Operator must engage with a content-moderation reference (or specialist) and seed it. The list update process (quarterly review per §26.11) ships in Prompt 24.
- **Pre-cruise port content.** §23.4 demands RAG seeding for 17 North American departure ports (Miami, Port Canaveral, Galveston, Seattle, Vancouver, New York, Boston, Baltimore, New Orleans, Los Angeles, San Diego, San Francisco, Long Beach, Tampa, Jacksonville, Mobile, Norfolk). Each needs: official port-authority URL, terminal addresses, parking info, transit/Uber drop-off, arrival advice. **Operator content task**; not blocking code. Prompt 23 ships with the seed-data harness and `// TODO(content)` placeholders.

### 4. Open items the spec leaves to implementation

- **§20 final booking UI** — deferred until launch host is selected, per the spec’s explicit `DESIGN STATUS` note.
- **§19.11 photo support in forum** — explicitly deferred to v7.
- **§23.9 Gmail inbound** — optional per tenant; ship the schema + the OAuth flow as a stub; defer the Pub/Sub plumbing if no tenant has asked for it at launch.
- **§24.6 persona-switching in-conversation surface** — depends on Build Prompt 10 `/api/conversation/handoff` already being in place; if Prompt 10 left it as a stub, Prompt 24 implements it.

-----

## How to use the build prompts below

Same as Parts 1–4. Each prompt is self-contained for Claude Code. The header block names the model; the footer switches back to Sonnet when the prompt used Opus. Run in order; review the diff, run tests, commit before moving on.

**Note on Opus distribution in this part:** **Four of the five prompts call for Opus.** This is heavier than Parts 3 and 4. Part 5 concentrates the platform’s AI-safety-critical work — fail-closed forum moderation, the eight-layer hallucination defense, the PII zero-tolerance ingestion pipeline tied to the chunk-license-survival contract from Part 4, and the hate-speech deterministic deny-list plus customer rate limiting. Each of these is hard-to-fix-later, screenshot-able-PR-incident territory. The cost of Opus is small relative to the cost of getting any one of them wrong.

-----

# BUILD PROMPT 20 — Forum-style group chat with fail-closed moderation; booking flow schema scaffolding

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** The §19.3 AI moderation pipeline is a fail-closed contract with a distinct retry state, idempotent retry job under optimistic locking, and a 24-hour timeout escalation path. The spec explicitly calls out fail-open as a “screenshot-able PR incident waiting to happen” — getting the state machine wrong here either burns out coordinators with engineering noise or leaves an abuse window during Haiku outages. The §20 booking-flow schema is short but the DOB-confirmation gate and the no-anonymous-bookings redirect have cross-cutting implications (booking submission can’t complete with an estimated DOB; an anonymous-to-authenticated transfer must preserve the in-progress draft) that ripple across the booking and CRM modules already in place. Both subsystems are correctness-critical at the schema level — fixing later means migrating data with live customer use happening.

**Spec references:** Part 5 §18.10 / §18.11 (sailed read-only state, coordinator portal tabs — completion of Part 4 §18), §19.1 (forum model), §19.2 (posting permissions), §19.3 (AI moderation pipeline with fail-closed contract, schema additions, retry job, failure-mode matrix, 24-hour escalation), §19.4 (screening dimensions), §19.5 (reactions), §19.6 (anonymity in forum), §19.7 (coordinator tools), §19.8 (edit/delete), §19.9 (user strike system), §19.10 (post-sailing forum), §19.11 (photo support — deferred), §20.1 (cross-implementation considerations), §20.2 (platform-native flow reference), §20.3 (entry points), §20.4 (AI co-pilot), §20.5 (DOB confirmation gate), §20.6 (validation layers), §20.7 (sub-host tenant-of-record disclosure), §20.8 (no anonymous bookings), §20.9 (cancellation & modification). Depends on Build Prompt 19 (groups + invitations from Part 4 §18), Build Prompt 11 (supervisor framework — the lexical denylist hook will be used here for forum messages too), Build Prompt 14 (`HostAgencyClient` for `.cancelBooking()` / `.modifyBooking()`).

**Prerequisite check:** Build Prompts 01–19 are committed. Haiku is reachable. The `groups` and `invitations` tables exist from Prompt 19. The host adapter framework from Prompt 14 has `cancelBooking` and `modifyBooking` stubs.

**Goal:** Build the forum-style group chat end-to-end with the fail-closed Haiku moderation contract, retry job, 24-hour coordinator escalation, screening dimensions, reactions, forum anonymity, coordinator tools, strike system, and post-sailing read-only transition. Then ship the booking-flow schema scaffolding — the schema fields and the platform-native fallback reference UI as a stub, with the DOB confirmation gate, the §20.7 tenant-of-record disclosure, and the no-anonymous-bookings redirect all implemented at the schema and middleware level so the platform is shape-correct regardless of whether the final UI ends up using a host widget.

**Tasks:**

1. **Env vars.** Extend `apps/main/src/lib/env.ts`:
   ```
   HAIKU_FORUM_MODERATION_MODEL (default 'claude-haiku-4-5-20251001')
   FORUM_MODERATION_HAIKU_TIMEOUT_MS (default 2000)
   FORUM_MODERATION_RETRY_TIMEOUT_HOURS (default 24)
   ```

2. **Forum schema.** Migration `apps/main/supabase/migrations/0021_forums.sql`:
   - `public.forums`: `id UUID PK`, `group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE UNIQUE`, `tenant_id UUID NOT NULL REFERENCES tenants(id)`, `is_locked BOOLEAN NOT NULL DEFAULT FALSE`, `created_at TIMESTAMPTZ DEFAULT NOW()`. One forum per group (the UNIQUE on group_id enforces).
   - `public.forum_threads`: `id UUID PK`, `forum_id UUID NOT NULL REFERENCES forums(id) ON DELETE CASCADE`, `tenant_id UUID NOT NULL REFERENCES tenants(id)`, `created_by_user_id UUID NOT NULL REFERENCES users(id)`, `title TEXT NOT NULL`, `is_locked BOOLEAN NOT NULL DEFAULT FALSE`, `is_pinned BOOLEAN NOT NULL DEFAULT FALSE`, `is_announcement BOOLEAN NOT NULL DEFAULT FALSE`, `deleted_at TIMESTAMPTZ`, `created_at TIMESTAMPTZ DEFAULT NOW()`.
   - `public.forum_messages`: `id UUID PK`, `thread_id UUID NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE`, `tenant_id UUID NOT NULL REFERENCES tenants(id)`, `forum_id UUID NOT NULL REFERENCES forums(id)`, `user_id UUID NOT NULL REFERENCES users(id)`, `parent_message_id UUID REFERENCES forum_messages(id)` (NULL for top-level, populated for one-level replies; CHECK that any non-NULL parent has its own `parent_message_id IS NULL` — enforcing one-level replies only per §19.1), `content TEXT NOT NULL`, `content_edited_at TIMESTAMPTZ`, `edit_history JSONB DEFAULT '[]'::jsonb`, `deleted_at TIMESTAMPTZ`, `status TEXT NOT NULL CHECK (status IN ('pending','visible','flagged_review','hidden','pending_moderation')) DEFAULT 'pending'`, `moderation_scores JSONB`, `moderation_decision_reason TEXT`, `created_at TIMESTAMPTZ DEFAULT NOW()`.
   - Per §19.3 schema addition: `ALTER TABLE public.forum_messages ADD COLUMN pending_moderation_since TIMESTAMPTZ, ADD COLUMN moderation_attempt_count INTEGER NOT NULL DEFAULT 0, ADD COLUMN moderation_last_attempt_at TIMESTAMPTZ, ADD COLUMN moderation_last_error TEXT`.
   - `public.forum_reactions`: `id UUID PK`, `message_id UUID NOT NULL REFERENCES forum_messages(id) ON DELETE CASCADE`, `user_id UUID NOT NULL REFERENCES users(id)`, `tenant_id UUID NOT NULL REFERENCES tenants(id)`, `emoji TEXT NOT NULL CHECK (emoji IN ('thumbs_up','heart','laugh','surprised','celebrate','eyes'))`, `created_at TIMESTAMPTZ DEFAULT NOW()`, `UNIQUE (message_id, user_id, emoji)`.
   - `public.forum_user_state`: `id UUID PK`, `forum_id UUID NOT NULL REFERENCES forums(id) ON DELETE CASCADE`, `user_id UUID NOT NULL REFERENCES users(id)`, `tenant_id UUID NOT NULL REFERENCES tenants(id)`, `is_muted BOOLEAN NOT NULL DEFAULT FALSE`, `muted_until TIMESTAMPTZ`, `muted_by_user_id UUID REFERENCES users(id)`, `mute_reason TEXT`, `strike_count INTEGER NOT NULL DEFAULT 0`, `UNIQUE (forum_id, user_id)`.
   - `public.forum_strikes`: `id UUID PK`, `forum_id UUID NOT NULL REFERENCES forums(id) ON DELETE CASCADE`, `user_id UUID NOT NULL REFERENCES users(id)`, `tenant_id UUID NOT NULL REFERENCES tenants(id)`, `message_id UUID REFERENCES forum_messages(id)`, `strike_kind TEXT NOT NULL CHECK (strike_kind IN ('ai_hidden','coordinator_hidden'))`, `created_at TIMESTAMPTZ DEFAULT NOW()`.
   - Indexes: `forum_messages (thread_id, created_at)` for thread render, `forum_messages (status) WHERE status IN ('pending_moderation','flagged_review')` for the queues, `forum_strikes (user_id, created_at)` for the 24-hour and cumulative checks.
   - RLS: every forum table tenant-scoped through the existing `tenantClient` pattern. Coordinator and platform-admin roles get read-through to all status values; regular invitees see only `status = 'visible'` (and their own messages regardless of status — they need to see their own pending submissions per the §19.3 “What the user sees” section).

3. **Posting permissions enforcement — §19.2.** Build `apps/main/src/lib/forums/permissions.ts`:
   - `canPost({ user, forum, thread }): boolean` — checks: forum-locked → only coordinator/platform-admin; thread-locked → only coordinator/platform-admin; user muted (not expired) → false; user’s invitation has `rsvp_state = 'not_going'` → false; otherwise true.
   - `canModerate({ user, forum }): boolean` — coordinator of the group OR platform-admin.
   - Every forum API endpoint calls these helpers as the first step.

4. **Message post endpoint with synchronous Haiku screen.** `POST /api/forums/:forumId/threads/:threadId/messages`:
   - Auth + posting permissions check (Task 3).
   - Insert `forum_messages` row with `status = 'pending'`. Use a transaction so the row exists before the Haiku call begins.
   - Synchronous Haiku call with `FORUM_MODERATION_HAIKU_TIMEOUT_MS` timeout, scoring across the §19.4 dimensions (spam, abuse, PII leak, off-topic promo, trip misinformation, solicitation, prompt injection). The prompt returns structured JSON `{ scores: { spam, abuse, pii_leak, off_topic, misinformation, solicitation, prompt_injection }, max_score, reasoning }`.
   - Decide status from `max_score` per §19.3:
     - `< 0.4` → `status = 'visible'`.
     - `0.4–0.7` → `status = 'flagged_review'` (coordinator-only visible).
     - `> 0.7` → `status = 'hidden'` (coordinator + platform-admin only).
   - Write `moderation_scores` and the chosen status.
   - If the message has any score ≥ 0.4, write a row to `forum_strikes` only when status is `hidden` (matches §19.9 “AI-hidden” count) — flagged_review messages don’t count as strikes (coordinator might unhide them).
   - **PII leak special case:** credit card patterns trigger zero-tolerance per §19.4 — if Haiku scores `pii_leak > 0.95` AND the response includes the `credit_card_pattern: true` flag, set `status = 'hidden'` regardless of other scores, and write to `audit_log` with a quarantine reason.
   - Return the message row to the submitter.

5. **Haiku failure handling — the fail-closed contract per §19.3.** In the same endpoint:
   - If the Haiku call times out (>`FORUM_MODERATION_HAIKU_TIMEOUT_MS`): set `status = 'pending_moderation'`, `pending_moderation_since = NOW()`, `moderation_last_error = 'haiku_timeout'`. Emit Inngest event `forum.message_needs_moderation_retry` with `{ message_id, tenant_id, forum_id }`.
   - If the Haiku call returns an explicit API error: same as timeout but `moderation_last_error = 'haiku_api_error: <code>'`.
   - If the Haiku call returns malformed JSON (can’t parse): same, with `moderation_last_error = 'haiku_malformed_response: <truncated payload>'`. Additionally, write to `audit_log` with category `engineering_attention_required` so the team sees the malformed pattern. Per §19.3 failure-mode matrix.
   - If the Haiku call returns an auth-failure or quota-exceeded error: same status, but also alert the platform admin via the existing notification path (this is a platform-level problem, not a coordinator problem, per §19.3 last bullet of Calls Worth Flagging).
   - In every failure case, the message is invisible to other users (status `pending_moderation` is filtered out of the regular thread view; only the submitter sees it).

6. **Inngest retry job — `forum-moderation-retry`.** Per §19.3:
   - Triggers on `forum.message_needs_moderation_retry`.
   - Backoff schedule: first retry at 5 minutes, second at 15 minutes, third at 60 minutes (compounding from the original `pending_moderation_since`).
   - Each retry uses `tenantClient` with `tenantContextFromInngestEvent` per the §11.2.2 pattern. Reads the message row.
   - **Optimistic locking:** the update conditions include `WHERE moderation_attempt_count = <expected>`. If two retry workers race, only one wins; the other is a no-op. Document the locking pattern in MEMORY.
   - On retry: increment `moderation_attempt_count`, set `moderation_last_attempt_at = NOW()`, call Haiku.
     - **Success:** set status per scores (`visible` / `flagged_review` / `hidden`), clear `pending_moderation_since` and `moderation_last_error`, write `moderation_scores`. Strike row created only on `hidden`.
     - **Failure again:** record `moderation_last_error`. If the message’s `pending_moderation_since` is older than `FORUM_MODERATION_RETRY_TIMEOUT_HOURS` (default 24): set `status = 'flagged_review'`, `moderation_decision_reason = 'moderation_timeout'`, clear pending state, do NOT auto-strike. Coordinator handles manually per §19.3.
   - Every retry attempt writes to `audit_log` with the attempt count and Haiku response detail. The retry job MUST be idempotent — verify by writing a test that fires the same Inngest event 3 times in parallel and asserts exactly one Haiku call won the update.

7. **24-hour escalation sweep.** Inngest scheduled function `forum-moderation-timeout-sweep` running every 15 minutes:
   - Find `forum_messages` where `status = 'pending_moderation'` AND `pending_moderation_since < NOW() - FORUM_MODERATION_RETRY_TIMEOUT_HOURS`.
   - For each: transition to `status = 'flagged_review'`, `moderation_decision_reason = 'moderation_timeout'`, with optimistic locking. The retry job also does this when it next runs; the sweep is a safety net for messages whose retry chain was somehow lost.

8. **What the user sees — §19.3 “What the user sees”.**
   - Submitter view: their own message is always visible to them (regardless of status). Status `pending_moderation` looks identical to `pending` on the submitter side — neither shows a “queued” indicator until 24h has passed and it becomes `flagged_review`, at which point the submitter sees “Your message is awaiting review.”
   - Other invitees: see only `status = 'visible'` messages.
   - Coordinator and platform admin: see all statuses with status badges (`flagged_review` shows yellow, `hidden` shows red).

9. **Reactions — §19.5.** Endpoints `POST /api/forums/messages/:id/reactions` and `DELETE /api/forums/messages/:id/reactions/:emoji`. Reactions are unique per (message, user, emoji). The bounded set is enforced at the CHECK constraint AND in the API.

10. **Anonymity — §19.6.** Build `apps/main/src/lib/forums/anonymity.ts`:
    - `effectiveForumDisplay({ user, invitation, viewer })`: returns `{ display_name, avatar_url }`. The viewer matters — coordinator and platform-admin always see real names; others see “Anonymous Traveler” + neutral avatar if the invitation says hidden.
    - The forum message rendering uses this helper for every message.
    - The underlying `user_id` is unchanged in the DB; only the rendered display is masked.

11. **Coordinator tools — §19.7.** Endpoints:
    - `PATCH /api/forums/messages/:id` with `{ action: 'hide' | 'unhide' | 'pin' }`. Hide writes to `forum_strikes` with `strike_kind = 'coordinator_hidden'`.
    - `PATCH /api/forums/users/:userId/state` for mute/unmute (with optional `muted_until` for temporary mutes).
    - `PATCH /api/forums/threads/:id` for lock / pin / mark-announcement / delete (soft via `deleted_at`).
    - `PATCH /api/forums/:id` for forum-wide lock/unlock.
    - All wrapped in `tenantClient` with the coordinator-or-platform-admin check; audited.

12. **Edit and delete — §19.8.** Self-edit endpoint preserves history in `edit_history` JSONB as an array of `{ content, edited_at }` entries. Self-delete is soft — set `deleted_at`; if any replies exist, the rendered message becomes `[message deleted]` placeholder. Hard delete is reserved for coordinator hide-then-delete flow (not implemented in v6 — coordinator soft-delete is sufficient).

13. **Strike system — §19.9.** Build `apps/main/src/lib/forums/strikes.ts`:
    - `recordStrike({ user, forum, message, kind })`: inserts a `forum_strikes` row.
    - `checkStrikePatterns(user, forum)`: runs after every strike. Patterns:
      - 3 `ai_hidden` strikes from this user within 24h → auto-mute for 24 hours (set `forum_user_state.is_muted = true`, `muted_until = NOW() + 24h`, `mute_reason = 'auto_three_ai_hidden_24h'`). Notify coordinator.
      - 5 `coordinator_hidden` strikes cumulative → coordinator gets a “review this user” surface entry (a new `forum_user_review_prompts` table or a UI flag — choose simpler).
      - 10 total strikes (either kind) cumulative → coordinator sees a “consider removing invitee” recommendation in the user’s review surface.
    - **All recommendations; no automatic bans.** Per §19.9 “Recommendations, not automatic bans. Coordinator has final say.”

14. **Post-sailing forum — §19.10.** When `groups.status = 'sailed'`, the forum stays fully active. Only difference: certain group surfaces (RSVP, invitations, group details) are read-only per Prompt 19 — but the forum continues. Verify this is the case after the Prompt 19 sailed-mark cron.

15. **Photo support — §19.11.** Explicitly NOT implemented in v6. Document in MEMORY at end of run. The forum message editor UI allows pasting URLs (which render as plain text links) but does NOT accept image uploads.

16. **Sailed/travel-start read-only enforcement — §18.10.** The spec under §18.10 specifies: at `travel_start_date`, the group becomes read-only for group details / RSVP / member management. Forum stays open. Implement in the group-edit endpoints with a `travel_start_date` check (the field already exists on the groups table as `sailing_date` from Prompt 19 — confirm naming, or alias). Document any column rename in MEMORY.

17. **Coordinator portal tabs — §18.11.** `/groups/:id/coordinate` shell page with five tabs: Overview, Invitees, Edit, Preview Email, Forum. Each tab is its own route under `/groups/:id/coordinate/[tab]`. The Forum tab embeds the forum view with coordinator privileges enabled. The Preview Email tab renders the current `GroupInvitation` template with the group’s data, rendered as it would be sent to invitees.

18. **Booking-flow schema scaffolding — §20.** Migration `apps/main/supabase/migrations/0022_booking_flow.sql`:
   - `ALTER TABLE public.bookings ADD COLUMN entry_point TEXT CHECK (entry_point IN ('quote_accepted','ai_chat','group_invitation','direct_cta','price_watch'))` per §20.3.
   - `ALTER TABLE public.bookings ADD COLUMN status TEXT CHECK (status IN ('draft','submitted','pending_host_review','pending_customer_reconfirmation','confirmed','rejected','cancelled','no_show','refunded')) DEFAULT 'draft'` if not already present from earlier migrations. If `status` already exists with a different enum, ALTER the CHECK to add the new values.
   - `public.booking_passengers`: `id UUID PK`, `booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE`, `tenant_id UUID NOT NULL REFERENCES tenants(id)`, `contact_id UUID REFERENCES contacts(id)`, `legal_first_name TEXT NOT NULL`, `legal_last_name TEXT NOT NULL`, `date_of_birth DATE NOT NULL`, `date_of_birth_is_estimated BOOLEAN NOT NULL DEFAULT FALSE`, `passport_number_encrypted TEXT`, `passport_expiry DATE`, `passport_country TEXT`, `is_lead_passenger BOOLEAN NOT NULL DEFAULT FALSE`, `created_at TIMESTAMPTZ DEFAULT NOW()`.
   - `public.booking_options`: `id UUID PK`, `booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE`, `tenant_id UUID NOT NULL REFERENCES tenants(id)`, `option_kind TEXT NOT NULL` (e.g., 'travel_insurance', 'beverage_package', 'specialty_dining'), `option_value JSONB NOT NULL`, `price_cents BIGINT NOT NULL DEFAULT 0`, `created_at TIMESTAMPTZ DEFAULT NOW()`.
   - RLS: all booking tables tenant-scoped via the existing pattern.

19. **DOB confirmation gate — §20.5.** Build `apps/main/src/lib/booking/dob-gate.ts`:
    - `assertNoEstimatedDOBs(bookingId)`: queries `booking_passengers`, throws `DOBEstimateUnresolvedError` listing the affected passenger names if any have `date_of_birth_is_estimated = true`.
    - The booking-submit handler (`POST /api/bookings/:id/submit` — extended from Build Prompt 15) calls this BEFORE attempting host adapter submission. If it throws, the API returns `409 Conflict` with the affected passenger names so the UI can prompt for confirmation.
    - The platform-native fallback UI Stage 2 (per §20.2) shows the DOB-estimated warning per §20.5: pre-filled date with a warning icon and the “We have [name]’s DOB as approximately [date]” copy.

20. **Sub-host tenant-of-record disclosure — §20.7.** Build a component `<TenantOfRecordDisclosure tenant={...} hostAgency={...} />`. Renders the §20.7 text exactly: “This booking will be made through [Host Agency Name]. Your sub-host: [Tenant Name]. Customer service contact: [Tenant Support Email].” Embed this component on:
    - The Stage 4 (Review) page of the booking flow.
    - The booking confirmation email.
    - The booking confirmation page.
    - The quote acceptance page (so the customer sees this before they accept too).
   The host agency name comes from `platform_settings.host_agency_legal_name` (added in Build Prompt 16 with operator confirmation placeholder).

21. **No anonymous bookings — §20.8.** Middleware on the booking-flow routes (`/booking/flow/*`):
    - If the user is anonymous, save the in-progress booking draft to `localStorage` under a deterministic key, redirect to `/signup?return=/booking/flow/...&claim=<draft-key>`.
    - After signup completes, the redirect target reads the draft from localStorage and rehydrates the flow. This piggybacks on the anonymous-to-authenticated transfer mechanism from Build Prompt 12.

22. **Validation layers — §20.6.** Build `apps/main/src/lib/booking/validation.ts`:
    - Per-field validators run on input (email format, passport expiry must be > sailing date + 6 months, DOB sanity per cruise-line age rules).
    - Cross-field validators run on stage transition (all passengers have DOBs, pricing math sums correctly).
    - Final-submission validator runs before host adapter call (all required fields populated, cruise line age rules satisfied, promo codes still valid).

23. **Platform-native fallback UI stub — §20.2.** Build the four-stage flow as a stub at `/booking/flow/[id]/[stage]`:
    - Stage 1: Trip details (cruise line, ship, sailing date — pre-filled if entry was from quote or AI chat).
    - Stage 2: Passenger details with DOB inputs, the estimated-DOB warning UI, lead-passenger toggle.
    - Stage 3: Booking options (insurance, addons).
    - Stage 4: Review with the `<TenantOfRecordDisclosure />` component, disclosures, accept-and-submit button.
    - The stub UI is functional but minimal styling. **The shell is in place so once a host is chosen, either the stub is fleshed out OR replaced with an iframe wrapper.** Document this in MEMORY.

24. **AI co-pilot panel — §20.4.** Embed the existing chat component (from Build Prompt 24 which builds the full chat UI) as a side panel on the booking flow pages. At this prompt’s shipping time, Build Prompt 24 hasn’t shipped yet — leave the AI co-pilot as a `// TODO(prompt-24)` slot in the layout. Functionality stubbed but the panel exists.

25. **Cancellation & modification — §20.9.** Endpoints `POST /api/bookings/:id/cancel` and `POST /api/bookings/:id/modify`:
    - Cancellation: compute refund impact via `hostAdapter.computeCancellationImpact(booking)`, show to customer in confirmation modal, on confirm call `hostAdapter.cancelBooking(booking)`. On success: set `bookings.status = 'cancelled'`, trigger the commission-reversal path from Build Prompt 15 §14.9 clawback handler.
    - Modification: call `hostAdapter.modifyBooking(booking, changes)`. The shape of allowed changes varies by adapter; the adapter declares capabilities. If a requested change isn’t supported, the API returns a structured error.

26. **Tests.**
    - **The most important test of this prompt:** post the same forum message 3 times in parallel under a Haiku-timeout simulation; assert exactly one `pending_moderation` row exists, the retry job winning row updates it, and the second/third parallel events are no-ops (optimistic locking proves out).
    - Forum permissions: muted user cannot post; not-going invitee cannot post; coordinator can post in locked forum.
    - Haiku-low-score message → `visible` immediately; medium-score → `flagged_review`; high-score → `hidden` + strike.
    - Haiku timeout → `pending_moderation`; retry succeeds → status moves to correct value; retry never succeeds for 24h → status becomes `flagged_review` with `moderation_timeout` reason.
    - Haiku malformed response triggers engineering-attention audit entry.
    - Strike patterns: 3 ai_hidden in 24h → auto-mute for 24h; 5 coordinator_hidden cumulative → coordinator review prompt; 10 cumulative → recommend-removal.
    - Forum anonymity: invitee viewing another anonymous invitee sees “Anonymous Traveler”; coordinator viewing sees real name.
    - Reactions: bounded set enforced; unique on (message, user, emoji).
    - Booking with estimated DOB cannot submit; clearing the estimate allows submit.
    - Anonymous user hitting booking flow is redirected to signup with draft preservation.
    - Tenant-of-record disclosure renders in all four required places.
    - Cancellation triggers commission reversal.

27. **Add to MEMORY.md at end of run:** (a) confirm the retry-job optimistic-locking strategy (which column is used for the version check); (b) the `sailing_date` vs `travel_start_date` column naming for the §18.10 read-only check; (c) photo support deferred to v7 per spec; (d) booking-flow stub UI deployed; future host decision will either flesh out or replace; (e) the AI co-pilot panel left as `// TODO(prompt-24)`.

**Definition of done:**

- A coordinator can post a thread; an invitee can reply; reactions work; coordinator can hide/unhide.
- Haiku timeout on message submit produces `pending_moderation` invisible to others.
- The parallel-retry test produces exactly one Haiku-result-update.
- 24-hour-old `pending_moderation` messages auto-escalate to `flagged_review`.
- Auto-mute and coordinator review-prompts fire correctly under strike thresholds.
- Booking-flow shell is reachable at `/booking/flow/[id]/[stage]`; submission with estimated DOB returns 409.
- Anonymous user hitting `/booking/flow/*` redirects with draft preservation.
- Tenant-of-record disclosure shows on review, confirmation page, confirmation email, and quote acceptance.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:migrations` all pass.

**After completion:** MEMORY.md entry per Task 27.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 21 — RAG consumer side, eight-layer hallucination defense, quote pricing discipline

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** The §21.10 eight-layer hallucination defense is the platform’s anti-hallucination posture; each layer’s threshold and interaction shapes how often the platform makes a wrong factual claim. The §21.10.1 quote-pricing audit snapshot is the dispute defense — if the customer later claims “you quoted me $3,847,” the audit record decides the dispute. Five of the eight defense layers were left as stubs in Build Prompt 11 (the supervisor preflight skeleton); making them real involves topic-specific guard logic, claim extraction against the RAG block, and arithmetic validation that has to work without false-positive friction. The cost of getting any one of these layers subtly wrong is platform-level: hallucinations slip through, pricing disputes occur, customers screenshot.

**Spec references:** Part 5 §21.1 (retrieval flow in chat), §21.2 (entity extraction), §21.3 (chunk filtering before prompt inclusion), §21.4 (RAG knowledge block format in prompt), §21.5 (citation in AI responses), §21.6 (customer-facing source transparency), §21.7 (outdated information handling), §21.8 (conflict handling), §21.9 (no-result handling), §21.10 (the eight-layer hallucination defense — consolidated), §21.10.1 (quote pricing discipline — estimate vs confirmed, variance, audit). Depends on Build Prompt 09 (RAG retrieve API), Build Prompt 10 (system-prompt builder), Build Prompt 11 (supervisor preflight skeleton with five stubs awaiting this prompt), Build Prompt 13 (quotes table), Build Prompt 15 (booking-submit handler).

**Prerequisite check:** Build Prompts 01–20 are committed. The RAG retrieval API from Prompt 09 returns chunks with composite_confidence scores. The supervisor preflight from Prompt 11 has the skeleton in place with five stubs marked `// TODO(part-5)`.

**Goal:** Build the chat-time RAG consumer path: entity extraction, query construction, retrieval, filter and sort, knowledge block formatting, citation, source transparency, freshness handling, conflict and no-result handling. Then implement the eight-layer hallucination defense including making real the five stubbed preflight checks from Prompt 11. Then ship §21.10.1 quote pricing discipline — the estimate-vs-confirmed PDF render, the customer-accepted variance recording, the booking-submit `pending_customer_reconfirmation` path, and the per-stage audit snapshot.

**Tasks:**

1. **Env vars.** Extend `apps/main/src/lib/env.ts`:
   ```
   ENTITY_EXTRACTION_MODEL (default 'claude-haiku-4-5-20251001')
   RAG_CHUNK_CONFIDENCE_FLOOR (default 0.35)
   RAG_CHUNK_DEDUP_SIMILARITY_THRESHOLD (default 0.8)
   RAG_CHUNK_TOP_N_DEFAULT (default 4, range 3–5)
   QUOTE_PDF_RENDERER ('puppeteer' | 'react-pdf' per prerequisites)
   QUOTE_ESTIMATE_VALIDITY_DAYS (default 7)
   QUOTE_DEFAULT_VARIANCE_CENTS (default 5000 — $50)
   ```

2. **Entity extraction — §21.2.** Build `apps/main/src/lib/rag/entity-extraction.ts`:
   - `extractEntities(message: string, conversationContext: {...}): EntitySet` — calls Haiku with a structured-output prompt requesting `{ destinations: string[], cruise_lines: string[], ships: string[], travel_dates: {...}, passenger_composition: string, intent: 'research'|'compare'|'book'|'support', categories_hint: string[] }`.
   - 1-second timeout. On timeout or error: return an empty `EntitySet` and proceed — entity extraction is best-effort, not load-bearing for retrieval (the message text itself is the primary query).
   - Cache by message-hash for 1 hour to avoid re-extracting on retries within the same conversation.

3. **Retrieval flow in chat — §21.1.** Build `apps/main/src/lib/rag/retrieve-for-chat.ts`:
   - Input: `{ message, conversation, persona, tenant_id, user_id }`.
   - Steps per the §21.1 diagram:
     1. Call entity extraction (Task 2).
     2. Construct the retrieval query: combine message text + entity strings + persona’s specialty keywords (from Build Prompt 10’s persona table).
     3. Call the RAG service’s `/retrieve` endpoint via the JWT-signed service-to-service path from Build Prompt 09. The retrieval call passes `{ query, tenant_id, top_k: 10 }` — fetch more than we’ll keep so post-filtering has options.
     4. Apply chunk filtering (Task 4).
     5. Format the knowledge block (Task 5).
     6. Return `{ knowledge_block, citations, retrieved_chunk_ids }` — citations are kept for the source-transparency UI in Task 6 and for the post-response feedback log in §6.10.

4. **Chunk filtering — §21.3.** Within `retrieve-for-chat.ts`:
   - Drop any chunk with `composite_confidence < RAG_CHUNK_CONFIDENCE_FLOOR`.
   - Drop chunks where `expires_at IS NOT NULL AND expires_at < NOW()`.
   - Closed-to-new promos: a chunk with `category = 'promo'` AND `promo_status = 'closed_to_new'` is dropped UNLESS the conversation has a `customer_has_booking` signal — which means: an existing `bookings` row for this customer with `status NOT IN ('cancelled','no_show','refunded')`. If yes, the closed promo is retained because the customer is already in the system.
   - Similarity dedup: cluster chunks by cosine similarity > `RAG_CHUNK_DEDUP_SIMILARITY_THRESHOLD`; keep the highest-scored from each cluster. The RAG service can provide the embedding distance via the retrieval response; if not, compute on the fly using the embeddings cached during ingestion.
   - Final cap: top N (default 4, range 3–5; reads from `RAG_CHUNK_TOP_N_DEFAULT`).

5. **Knowledge block formatting — §21.4.** Build `apps/main/src/lib/rag/format-block.ts`:
   - Render the chunks into the exact prose format from §21.4 — header `KNOWLEDGE CONTEXT (retrieved for this turn):`, per-chunk numbered blocks with Authority / Recency / Match / Confidence scores, Category, Source, Indicator (★ rating computed from confidence), content. End with the `INSTRUCTIONS:` block exactly as in §21.4.
   - The ★ rating: 5 stars for confidence ≥ 0.9, 4 for ≥ 0.8, 3 for ≥ 0.7, 2 for ≥ 0.5, 1 for ≥ 0.35.
   - Returns a single string ready for injection into the persona system prompt.

6. **Citation in AI responses — §21.5.** This is a persona-prompt instruction, not a code change. Update the persona system prompt builder (from Build Prompt 10) to include the §21.5 citation instructions when the knowledge block is non-empty:
   - “Cite retrieved sources inline using natural prose (e.g., ‘per Royal Caribbean’s official site’).”
   - For sub-host scenarios where the chunk’s `source_type = 'tenant_verified'`, the citation phrasing is “your agency’s records” or equivalent — preserving white-label trust.

7. **Customer-facing source transparency — §21.6.** Build a React component `<MessageSources citations={[...]} />`:
   - Subtle indicator next to assistant messages that used RAG (a small icon).
   - Hover/click expands to a panel showing source title, ★ confidence rating, excerpt (truncated chunk content).
   - Tenant-configurable visibility: `tenant_settings.show_chat_sources BOOLEAN DEFAULT TRUE`. When FALSE, the indicator is hidden — the persona still cites in prose; only the click-to-expand UI is hidden. Add this setting to `tenant_settings` in the migration for this prompt.

8. **Outdated information handling — §21.7.** Within the knowledge-block formatter:
   - Tag chunks where `category IN ('pricing','promo','schedule','policy')` with a freshness caveat instruction.
   - Compute chunk age vs category half-life (from `platform_settings.category_halflives_days` JSONB — default `{ pricing: 7, promo: 14, schedule: 30, policy: 90 }`). If age > halflife: prepend an inline “may be outdated” marker in the rendered block AND add to the source-transparency UI a “may be outdated” badge.
   - Hard-expired chunks were already dropped by Task 4 filtering.

9. **Conflict handling — §21.8.** This is mostly a persona-prompt instruction (§21.4’s INSTRUCTIONS block already covers it). Add no extra code — the prompt handles it. But: chunks where `authority_kind = 'authoritative_override'` are tagged with a stronger “WIN” indicator in the knowledge block so the persona knows to prefer them regardless of other authority scores.

10. **No-result handling — §21.9.** Within `retrieve-for-chat.ts`:
    - If after filtering, zero chunks remain: return an empty `knowledge_block` with a specific instructions-only block:
      ```
      KNOWLEDGE CONTEXT: No retrieved chunks for this turn.

      INSTRUCTIONS:
      - Do not fabricate specific facts (prices, dates, dining venue names, cabin
        layouts, policies) — you have no verified content on this topic.
      - You may share general cruise-industry knowledge with appropriate caveats.
      - If the user asks for specifics you cannot verify, acknowledge honestly:
        "I don't have specific information on that. Would you like me to check
        with our team?"
      - Consider escalation if the topic is high-stakes (medical, accessibility,
        legal, contractual).
      ```
    - This is non-negotiable behavior, not a soft suggestion. The persona prompt builder must include this instructions block whenever the knowledge block would otherwise be empty.

11. **The eight-layer hallucination defense — §21.10.** Implement (or finalize) each layer:
    - **Layer 1 — Persona prompt instructions.** Already in place from Build Prompt 10’s system-prompt builder. Verify the persona prompts include: forbid unsupported facts, require hedging on uncertain claims, require freshness caveats for time-sensitive content. If any persona is missing this language, add it.
    - **Layer 2 — RAG grounding.** Tasks 3–5 above provide the chunks with metadata.
    - **Layer 3 — Hallucination risk check.** Implement the supervisor preflight `hallucination_risk` check (stubbed in Build Prompt 11). Extracts factual claims from the AI’s candidate response using a Haiku call returning `{ claims: [{ text, claim_type }] }`. For each claim, attempts to find supporting content in the retrieved chunks via embedding similarity (no separate model call — use the chunks already in context). Claims with no chunk support above 0.7 similarity AND that aren’t reasonable general knowledge (Haiku judges via a follow-up call) are flagged. If ≥ 1 claim is flagged: regenerate with strict grounding instructions. Counts against the regen budget from Build Prompt 11.
    - **Layer 4 — Confidence floor.** Already enforced in Task 4. No further work.
    - **Layer 5 — Promise detection.** Implement the supervisor `promise_detection` check (stubbed in Build Prompt 11). Deterministic regex match against terms: `\bguarantee\w*\b`, `\bI assure\b`, `\bI promise\b`, `\bdefinitely\b` (in financial or commitment contexts — context awareness via Haiku follow-up only on hit), `\bwill be\b` (in policy-claim contexts — same). On match: regenerate with “avoid making over-confident commitments” instruction.
    - **Layer 6 — Arithmetic check.** Implement the supervisor `arithmetic_check` (stubbed). Scans the candidate response for arithmetic expressions (numbers + operators + result, e.g., “$129 × 7 = $903”). For each expression: parse, compute, compare. Tolerance: $0.01 for money, 0.1% for percentages. On mismatch: regenerate with “your response contains an arithmetic error” instruction.
    - **Layer 7 — Customer feedback.** Already wired in Build Prompt 09 (thumbs-down feeds authority nudges). No new work — confirm the feedback button in Build Prompt 24’s chat UI is wired to the existing endpoint.
    - **Layer 8 — Escalation safety net.** Implement the supervisor `escalation_safety_net` check (stubbed). When the conversation has signals: low retrieved-chunk confidence (max chunk confidence < 0.5), AND the user message intent is `medical | accessibility | legal | dietary | contractual` (from entity extraction), AND no escalation has been offered in the last 3 turns: inject an instruction to suggest human handoff.
    - **Topic-specific guards per §21.10:**
      - Pricing topics: cap retrieved chunks at composite_confidence 0.55 (lower cap than the confidence floor — pricing chunks are special). Inject freshness caveat. Enforce arithmetic check regardless of whether arithmetic appears (extract claimed prices and validate against chunks).
      - Medical / accessibility / dietary: persona is forbidden from giving advice via the persona prompt (already in place from Build Prompt 10 if the persona is one that doesn’t specialize; otherwise the §10.3 escalation_topics catches these).
      - Legal / contractual: persona is forbidden from giving advice; references documentation only via the persona prompt.
      - Date and availability: never asserted by AI in narrative; always pulled from the `search_host_inventory` tool. Confirm Build Prompt 10’s tool registry includes this tool stub.
      - Loyalty programs: cited from RAG only; persona instructed to suggest member-direct verification.

12. **Measurement points — §21.10.** Add metrics emission for each defense layer:
    - Hallucination risk check fire rate (per conversation, per persona)
    - Block-after-regen rate (per persona)
    - Escalation rate due to confidence floor (per topic)
    - Thumbs-down rate per persona per topic
    - Per-chunk role in flagged responses (Build Prompt 09’s authority loop already records this; confirm)
    - Compound metric: thumbs-down × confidence
    - Emit via the existing observability path (assumed in place from Part 7 §28 — if not, emit to `audit_log` with category `metric.rag_defense` and structure the entries so they can be aggregated later).

13. **Quote pricing discipline — §21.10.1.** Migration `apps/main/supabase/migrations/0023_quote_pricing.sql`:
    - `ALTER TABLE public.quotes ADD COLUMN price_kind TEXT CHECK (price_kind IN ('estimate','confirmed')) DEFAULT 'estimate'`.
    - `ALTER TABLE public.quotes ADD COLUMN price_lock_token TEXT`.
    - `ALTER TABLE public.quotes ADD COLUMN price_lock_expires_at TIMESTAMPTZ`.
    - `ALTER TABLE public.quotes ADD COLUMN customer_accepted_variance_cents BIGINT`.
    - `ALTER TABLE public.quotes ADD COLUMN customer_accepted_at TIMESTAMPTZ`.
    - `ALTER TABLE public.quotes ADD COLUMN customer_accepted_audit_id UUID REFERENCES audit_log(id)`.
    - `ALTER TABLE public.tenant_settings ADD COLUMN quote_variance_cents BIGINT NOT NULL DEFAULT 5000` (the per-tenant variance threshold).
    - Add `platform_settings` row `quote_estimate_validity_days = 7`.

14. **Quote kind resolution — §21.10.1.** Build `apps/main/src/lib/quotes/kind-resolver.ts`:
    - `resolveQuoteKind(quote, hostAdapter)`: returns `'confirmed'` if:
      1. Quote was generated within the last 15 minutes (`quote.priced_at >= NOW() - INTERVAL '15 minutes'`), AND
      2. The host adapter declares `supportsPriceLock = true` in its capabilities AND the response included a `price_lock_token` AND the token is currently valid (`price_lock_expires_at >= NOW()`).
    - Otherwise returns `'estimate'`.
    - Confirm Build Prompt 14’s host adapter capabilities surface `supportsPriceLock`; add it if absent.

15. **Quote PDF rendering — §21.10.1.** Build the quote PDF renderer using the chosen library (`puppeteer` or `react-pdf` per env):
    - **ESTIMATE quotes (default):**
      - Header banner: “ESTIMATE — pricing subject to confirmation at booking”
      - Inline: every price line has a small “est.” marker.
      - Footer: the exact §21.10.1 footer text with `$X variance` interpolated from `tenant_settings.quote_variance_cents`.
      - Validity: 7 days (`quote_estimate_validity_days` from platform_settings). After 7 days the quote auto-expires.
    - **CONFIRMED quotes (rare at launch):**
      - Header: “QUOTE — price locked through [timestamp]”
      - Inline: no “est.” marker.
      - Footer: the exact §21.10.1 footer with the host name and timestamp.
      - Validity: matches `price_lock_expires_at`.

16. **Quote auto-expiry cron.** Inngest scheduled function `quote-estimate-expiry-sweep` running daily at 02:00 UTC:
    - For each `quotes` row with `price_kind = 'estimate' AND priced_at < NOW() - 7 days AND status = 'sent' AND customer_accepted_at IS NULL`: transition `status = 'expired'`, send the customer an email with a “request fresh quote” CTA.

17. **Quote acceptance flow — §21.10.1.** `POST /api/quotes/:id/accept` (customer-facing):
    - For ESTIMATE quotes: record `customer_accepted_variance_cents = tenant_settings.quote_variance_cents` AND `customer_accepted_at = NOW()`. Write an `audit_log` row capturing the rendered PDF snapshot (URL to the stored PDF) and the prices the customer saw, AND store the `audit_log.id` in `customer_accepted_audit_id`. This is the dispute defense.
    - For CONFIRMED quotes: record the price_lock_token and `price_lock_expires_at`. Submit booking immediately if the customer also clicked “book now” — otherwise the booking is created in draft state.

18. **Booking-submit handler — §21.10.1 contract.** Extend the booking-submit handler from Build Prompt 15:
    1. Resolve the underlying quote.
    2. If quote `price_kind = 'confirmed'` AND `price_lock_expires_at >= NOW()`: submit at the locked price via `hostAdapter.submitBooking(booking, { price: quote.locked_price_cents })`.
    3. If quote `price_kind = 'estimate'`:
       a. Call `hostAdapter.getCurrentPrice(booking)`.
       b. Compute `variance_cents = abs(host_price - quote.estimate_price_cents)`.
       c. If `variance_cents <= quote.customer_accepted_variance_cents`: submit at host price. (`commissions` row uses the actual price, not the estimate.)
       d. If outside variance: set `bookings.status = 'pending_customer_reconfirmation'`. Send the customer an email with the new price and a one-click re-confirm CTA. Do NOT submit to the host. The booking sits in this state until the customer re-accepts (which writes a new audit_log snapshot) or cancels.

19. **Audit at every step.** Every quote send, quote acceptance, and quote re-confirmation writes to `audit_log` with action `quote.sent | quote.accepted_estimate | quote.accepted_confirmed | quote.reconfirmation_requested | quote.reconfirmation_accepted` and the snapshot — the rendered PDF URL, the prices, the variance threshold, the customer’s identity. Per §21.10.1 “Audit” subsection.

20. **Tests.**
    - Entity extraction returns structured output on happy path; returns empty set on timeout.
    - Chunk filtering: confidence floor drops low-confidence chunks; expired chunks dropped; closed-to-new promo kept only when customer has booking; dedup keeps highest-scored from cluster; final cap at top N.
    - Knowledge block format matches §21.4 verbatim (test via string-snapshot).
    - Hallucination risk check fires on a claim not in chunks; regenerates with strict grounding; respects regen budget.
    - Promise detection fires on “I guarantee” in a financial context; doesn’t fire on “I guarantee the cabin has a window” (not a financial claim — Haiku-judged context).
    - Arithmetic check fires on “$129 × 7 = $1,000” (correct answer is $903); doesn’t fire when within $0.01 tolerance.
    - Escalation safety net fires on a medical-intent question with low chunk confidence; doesn’t fire if escalation was offered in the last 3 turns.
    - Topic-specific: a pricing-topic chunk is capped at 0.55 in the knowledge block.
    - No-result: empty knowledge block triggers the don’t-fabricate instructions in the persona prompt.
    - Quote kind: 14-minute-old quote with `supportsPriceLock=true` and valid token → confirmed; 16-minute-old → estimate; 14-minute-old without price_lock_token → estimate.
    - Quote acceptance: estimate accepts variance, writes audit snapshot, stores the audit_id; confirmed records lock token.
    - Booking submit: estimate with host price $25 over (within $50 variance) → submits at host price; $75 over (outside variance) → goes to `pending_customer_reconfirmation` with email sent; confirmed quote submits at locked price even if host price is different.
    - Quote auto-expiry: 8-day-old unaccepted estimate is marked expired; customer emailed.

21. **Add to MEMORY.md at end of run:** (a) PDF renderer chosen (`puppeteer` or `react-pdf`); (b) which preflight stubs from Prompt 11 were filled in this run vs remain stubs (should be all five); (c) confirm `supportsPriceLock` capability added to host adapter framework; (d) any divergence in arithmetic-check tolerance.

**Definition of done:**

- A chat message triggers entity extraction → retrieval → filtering → knowledge block → response, with the block matching §21.4 format exactly.
- Hallucination risk check, promise detection, arithmetic check, escalation safety net are all live (the five Prompt-11 stubs reduced to zero).
- No-result chat turns inject the don’t-fabricate instructions.
- Quote PDFs render as ESTIMATE by default; CONFIRMED only when both 15-minute and price-lock conditions met.
- Quote acceptance records the customer-accepted variance and an audit_log snapshot ID.
- Booking submit pauses to `pending_customer_reconfirmation` when host price is outside the customer’s authorized variance.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:migrations` all pass.

**After completion:** MEMORY.md entry per Task 21.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 22 — RAG ingestion: normalization, PII zero-tolerance, four-tab global review

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** This prompt builds the path by which content enters the platform’s knowledge corpus — and once content is in, the chunk-license-survival contract from Part 4 §15.14.3 means the platform retains the license even after the tenant terminates. The §22.4 normalization pipeline’s PII redaction stage has a **zero-tolerance** rule for SSN and credit-card patterns; quarantine and alert behavior must be exactly right or operators get burned out, or worse, slip and miss a real PII leak. The §22.4a aggregation rules have specific semantics (first instance always alerts, 24-hour window aggregates, 3-day pattern feeds §27 abuse signal) that don’t simplify. The §22.6 revised global review model is a legal posture decision encoded in code — platform admin can promote any tenant chunk under the ToU; getting this wrong (e.g., requiring tenant consent at promote time) creates an asymmetry where the runtime believes one thing and the contract says another.

**Spec references:** Part 5 §22.1 (submission methods), §22.2 (no submission limits — design decision), §22.3 (supported file types), §22.4 (normalization pipeline), §22.4a (PII quarantine alert aggregation), §22.5 (tenant review queue), §22.6 (revised global review model — design decision; ties to Part 4 §15.14.3 chunk-license-survival), §22.7 (four-tab global review queue), §22.8 (promotion mechanics — `withPlatformAdminAudit`), §22.9 (browser extension capabilities), §22.10 (iOS shortcut capabilities), §22.11 (quality signals from submissions), §22.12 (re-ingestion with duplicate detection), §22.13 (failure modes). Depends on Build Prompt 09 (RAG `/ingest` and `/approve` endpoints), Build Prompt 10 (Haiku model availability), Build Prompt 17 (`withPlatformAdminAudit` from Part 4 termination flow), Build Prompt 27 (abuse signals — built in Part 6; this prompt emits events for it).

**Prerequisite check:** Build Prompts 01–21 are committed. The RAG service from Prompt 09 has `/ingest` and `/approve` endpoints. File parsers and OCR provider are installed per prerequisites. Haiku is reachable.

**Goal:** Build the full RAG ingestion pipeline — all six submission methods, the file type handlers, the four-stage normalization pipeline (extraction → PII redaction → AI normalization → auto-flag) with the PII zero-tolerance quarantine and 24-hour aggregation rules, the tenant review queue, the four-tab global review queue with the revised model (platform admin can promote any tenant chunk), the promotion mechanics tied to the chunk-license-survival contract from Part 4, and re-ingestion with duplicate detection.

**Tasks:**

1. **Env vars.** Per prerequisites, plus:
   ```
   RAG_INGEST_PII_REDACTION_HAIKU_MODEL (default 'claude-haiku-4-5-20251001')
   RAG_INGEST_NORMALIZATION_HAIKU_MODEL (default 'claude-haiku-4-5-20251001')
   RAG_INGEST_GLOBAL_RELEVANCE_AUTOFLAG_THRESHOLD (default 0.6)
   RAG_INGEST_AGGREGATION_WINDOW_HOURS (default 24)
   RAG_INGEST_RECURRING_PATTERN_DAYS (default 3)
   ```

2. **Submission methods — schema for ingestion queue.** Migration `apps/main/supabase/migrations/0024_rag_ingestion.sql` (this lives on the MAIN app side, not the RAG service side — the tenant review queue is a main-app feature; ingestion forwards to the RAG service via its `/ingest` endpoint):
   - `public.rag_submissions`: `id UUID PK`, `tenant_id UUID NOT NULL REFERENCES tenants(id)`, `submitted_by_user_id UUID NOT NULL REFERENCES users(id)`, `submission_method TEXT NOT NULL CHECK (submission_method IN ('web_ui','browser_extension','ios_shortcut','file_upload','manual_entry','batch_api'))`, `source_url TEXT`, `source_title TEXT`, `original_content TEXT`, `original_file_path TEXT`, `original_file_mime_type TEXT`, `extraction_status TEXT CHECK (extraction_status IN ('pending','extracting','extracted','failed')) DEFAULT 'pending'`, `extracted_content TEXT`, `extraction_error TEXT`, `pii_redaction_status TEXT CHECK (pii_redaction_status IN ('pending','clean','redacted','quarantined')) DEFAULT 'pending'`, `redacted_content TEXT`, `quarantine_categories TEXT[]`, `normalization_status TEXT CHECK (normalization_status IN ('pending','normalized','failed')) DEFAULT 'pending'`, `normalization_result JSONB`, `review_status TEXT CHECK (review_status IN ('pending','ready_for_review','approved','rejected','superseded')) DEFAULT 'pending'`, `auto_flagged_for_global BOOLEAN NOT NULL DEFAULT FALSE`, `content_hash TEXT`, `chunk_id_created UUID`, `tenant_review_decision_by_user_id UUID REFERENCES users(id)`, `tenant_review_decision_at TIMESTAMPTZ`, `tenant_review_rejection_reason TEXT`, `created_at TIMESTAMPTZ DEFAULT NOW()`, `updated_at TIMESTAMPTZ DEFAULT NOW()`.
   - `public.rag_global_promotions`: `id UUID PK`, `submission_id UUID NOT NULL REFERENCES rag_submissions(id)`, `tenant_chunk_id UUID NOT NULL`, `global_chunk_id UUID NOT NULL`, `promoted_by_user_id UUID NOT NULL REFERENCES users(id)`, `promotion_source TEXT CHECK (promotion_source IN ('auto_flagged','tenant_suggested','admin_browse','admin_one_off')) NOT NULL`, `notes TEXT`, `audit_log_id UUID REFERENCES audit_log(id)`, `demoted_at TIMESTAMPTZ`, `demoted_by_user_id UUID REFERENCES users(id)`, `demote_audit_log_id UUID REFERENCES audit_log(id)`, `promoted_at TIMESTAMPTZ DEFAULT NOW()`.
   - Per §22.4a schema: `ALTER TABLE public.tenants ADD COLUMN pii_quarantine_alert_window_start TIMESTAMPTZ, ADD COLUMN pii_quarantine_alert_count_in_window INTEGER NOT NULL DEFAULT 0, ADD COLUMN pii_quarantine_recurring_days INTEGER NOT NULL DEFAULT 0`.
   - Indexes: `rag_submissions (tenant_id, review_status) WHERE review_status = 'ready_for_review'` (tenant review queue), `rag_submissions (content_hash, tenant_id)` (duplicate detection), `rag_submissions (auto_flagged_for_global) WHERE auto_flagged_for_global = TRUE AND review_status = 'approved'` (auto-flagged global queue), `rag_global_promotions (demoted_at) WHERE demoted_at IS NULL` (current promotions).
   - RLS: tenant_scoped reads on rag_submissions; platform_admin can read across tenants via `withPlatformAdminAudit`.

3. **Submission method: Web UI single-item — §22.1.** Route `/knowledge/submit` (tenant member role):
   - Form fields: content (textarea), source URL (optional), source title (optional), category hint (dropdown from `platform_settings.rag_categories`).
   - On submit: insert `rag_submissions` row with `submission_method='web_ui'`, `original_content`, `extraction_status='extracted'` (no extraction needed), trigger Inngest event `rag.submission_ready_for_pipeline` with `{ submission_id }`.

4. **Submission method: File upload — §22.1, §22.3.** Route `POST /api/rag/submit/file`:
   - Accepts multipart/form-data with up to `RAG_INGEST_MAX_FILE_SIZE_BYTES` (50MB default).
   - Validate MIME against supported types per §22.3.
   - Save file to Supabase Storage under `tenant_{tenant_id}/rag_submissions/{submission_id}/{filename}`.
   - Insert `rag_submissions` row with `original_file_path`, `original_file_mime_type`, `extraction_status='pending'`.
   - Trigger Inngest event `rag.submission_needs_extraction`.

5. **Submission method: Browser extension — §22.9.** Skeleton implementation:
   - Endpoint `POST /api/rag/submit/extension` accepts `{ url, page_title, selection, oauth_token }`.
   - OAuth token validated via Supabase Auth (the extension authenticated the user separately).
   - Insert `rag_submissions` row with `submission_method='browser_extension'`, `source_url=url`, `source_title=page_title`, `original_content=selection`.
   - The actual extension code (manifest, content script, etc.) lives in a separate repo (`apps/browser-extension/` or external) — this prompt ships the API endpoint and a `docs/browser-extension.md` that documents the manifest shape and the required OAuth flow.

6. **Submission method: iOS Shortcut — §22.10.** Endpoint `POST /api/rag/submit/ios-shortcut`:
   - Accepts text, URL, image, PDF via multipart.
   - OAuth token validated.
   - Same downstream as file upload or web UI depending on attachment kind.
   - Ship the Shortcut definition as a downloadable `.shortcut` file at `/downloads/ios-shortcut/AddToKnowledge.shortcut` — generated by an operator-side tool, not by code. Document this in MEMORY as an operator task.

7. **Submission method: Manual entry — §22.1.** Same as web UI single-item submit — just a different prompt label. Could reuse the same form; document choice in MEMORY.

8. **Submission method: Batch API — §22.1.** Endpoint `POST /api/rag/submit/batch` (service-token auth via Build Prompt 08’s service JWT pattern, NOT user-OAuth):
   - Accepts a JSON array of up to 100 items, each shaped like the web UI submit.
   - Validates each item; rejects the whole batch on validation failure (atomic).
   - Inserts up to 100 `rag_submissions` rows in a transaction, triggers one Inngest event per row.

9. **No submission limits enforcement — §22.2.** Per the design decision, `tenant_registry.rag_submit_daily_limit` and `rag_chunks_max` are nullable; null = unlimited. Confirm Build Prompt 06 / 08’s tenant_registry already has these columns nullable (if not, an ALTER here is required). The submission endpoints do NOT enforce volume limits; abuse handling is §27’s domain (quality patterns, not volume).

10. **Stage 1 — Content extraction.** Inngest function `rag-extract-content`:
    - Triggered by `rag.submission_needs_extraction` or auto-triggered after submission if `extraction_status='pending'`.
    - Reads `rag_submissions.original_file_path`, downloads from Storage, dispatches by `original_file_mime_type` to the appropriate parser:
      - PDF: `pdf-parse` first; if it produces empty text, fall back to OCR via the configured provider.
      - DOCX: `mammoth`.
      - DOC: `libreoffice --headless --convert-to docx` first, then mammoth.
      - XLSX/XLS: `SheetJS`; one chunk per sheet typically, preserve structure.
      - PPTX/PPT: PPTX reader; slide-by-slide chunking.
      - TXT/MD: direct read.
      - HTML: `cheerio` for content extraction; strip nav/footer/scripts.
      - JPG/PNG: OCR via configured provider (Tesseract or GCV). If Haiku-vision is available as a richer option (per spec §22.3), use it for images that fail OCR confidence threshold.
    - On success: set `extracted_content`, transition to `extraction_status='extracted'`, trigger `rag.submission_ready_for_pii_redaction`.
    - On failure: set `extraction_status='failed'`, `extraction_error=<message>`, surface to tenant as a failed submission per §22.13.

11. **Stage 2 — PII redaction with zero-tolerance — §22.4 + §22.4a.** Inngest function `rag-pii-redact`:
    - Triggered by `rag.submission_ready_for_pii_redaction`.
    - **Regex pass first** (cheaper, deterministic):
      - SSN pattern: `\b\d{3}-\d{2}-\d{4}\b` (and variants without dashes when surrounded by SSN context cues).
      - Credit card pattern: Luhn-validating sequences of 13–19 digits with optional spaces or dashes. Use a Luhn check to reduce false positives.
      - On ANY zero-tolerance match: set `pii_redaction_status='quarantined'`, `quarantine_categories=['ssn'|'credit_card']`. **DO NOT proceed to Stage 3.** Trigger the aggregation handler (Task 12).
    - **Haiku redaction pass** (for tolerable PII):
      - Prompt Haiku with the extracted content, ask it to identify and redact names, emails, phone numbers (with `[REDACTED]` placeholder).
      - On response: set `redacted_content`, transition to `pii_redaction_status='redacted'`.
      - If no PII found: `pii_redaction_status='clean'`, `redacted_content=extracted_content` (no change).
    - On either clean or redacted path: trigger `rag.submission_ready_for_normalization`.

12. **PII quarantine alert aggregation — §22.4a.** Build `apps/main/src/lib/rag/pii-quarantine-aggregator.ts`:
    - Called from Stage 2 when `pii_redaction_status='quarantined'`.
    - **Pseudo-code per §22.4a:**
      1. Read `tenants.pii_quarantine_alert_window_start` for this tenant.
      2. If window_start is NULL or older than `RAG_INGEST_AGGREGATION_WINDOW_HOURS` ago: this is a fresh window. Set `pii_quarantine_alert_window_start = NOW()`, `pii_quarantine_alert_count_in_window = 1`. Send immediate alert email to platform admin. Increment `pii_quarantine_recurring_days` if the previous window ended within the last 24 hours (suggesting consecutive-day pattern); otherwise reset to 1.
      3. If window_start is within `RAG_INGEST_AGGREGATION_WINDOW_HOURS`: this is a within-window match. Increment `pii_quarantine_alert_count_in_window`. **Do NOT send a new alert.** Instead, update the existing platform-admin alert in-place with the new count, sample categories (first 3), and updated time range.
    - **Pattern detection per §22.4a:** If `pii_quarantine_recurring_days >= RAG_INGEST_RECURRING_PATTERN_DAYS (default 3)`: emit Inngest event `tenant.rag_pii_recurring_pattern_detected` with `{ tenant_id, recurring_days, total_count_window }`. The Build Prompt 27 abuse subsystem (Part 6) listens for this and produces a `rag_pii_recurring` abuse signal that surfaces on the §27.10 dashboard. At this prompt’s shipping time Build Prompt 27 isn’t built; emit the event and document a `// TODO(part-6)` consumer.
    - The original immediate-alert email content includes a link to the platform admin’s RAG submission review page filtered to quarantined items for this tenant. The aggregated update is via the same alert (in-place update).
    - **Important:** quarantined content remains quarantined regardless of aggregation. The rule affects ALERT delivery only.

13. **Stage 3 — AI normalization — §22.4.** Inngest function `rag-normalize`:
    - Triggered by `rag.submission_ready_for_normalization`.
    - Calls Haiku with the redacted content and a structured-output prompt requesting:
      ```
      {
        suggested_category: string,
        cruise_line: string | null,
        ship: string | null,
        destination: string | null,
        summary: string,
        quality_score: number (0-1),
        authority_score: number (0-1),
        pricing_detected: boolean,
        promo_detected: boolean,
        promo_dates: { start: string | null, end: string | null },
        global_relevance_score: number (0-1)
      }
      ```
    - On success: write to `normalization_result` JSONB. If `global_relevance_score >= RAG_INGEST_GLOBAL_RELEVANCE_AUTOFLAG_THRESHOLD (default 0.6)`: set `auto_flagged_for_global = TRUE`.
    - Transition `normalization_status='normalized'`, `review_status='ready_for_review'`.
    - On retry exhaustion (>3 retries with backoff): set `normalization_status='failed'`; queue for manual review without AI metadata per §22.13.

14. **Stage 4 — Insert into knowledge_ingestion_queue.** This is just the transition `review_status='ready_for_review'` from Task 13. Tenant admin notified via in-app notification (`notifications` table from Build Prompt 23 if shipped; otherwise via the existing notification path).

15. **Tenant review queue — §22.5.** Route `/tenant-admin/rag/queue` (tenant_member role with `rag_review` permission):
    - List view: paginated, filterable by source type, category, date.
    - Side-by-side detail view: original content (or extracted_content) | AI-normalized version | suggested metadata.
    - Edit affordances: content (textarea), category override, authority override (with required reason field if changed), expiry date.
    - Actions per item: Approve, Reject (with reason — fed to abuse signals per §27), Edit-and-approve.
    - Bulk approve: when selected count > 10, show a safety prompt “You’re about to approve N items in bulk. Continue?”
    - **Approve action:** Call the RAG service’s `/approve/tenant` endpoint (from Build Prompt 09) with the submission data. On success: receive `chunk_id`, write to `rag_submissions.chunk_id_created`, transition `review_status='approved'`. If `auto_flagged_for_global=TRUE`, the chunk now appears in the global review queue (Task 17).
    - **Reject action:** transition `review_status='rejected'`, write `tenant_review_rejection_reason`. Emit `tenant.rag_submission_rejected` event (consumed by abuse signals).

16. **Re-ingestion / duplicate detection — §22.12.** When a new submission is processed in Stage 1 (content extraction):
    - Compute `content_hash = sha256(extracted_content)`.
    - Query `rag_submissions WHERE tenant_id = current_tenant AND content_hash = computed_hash AND review_status = 'approved'` — if a match exists: surface the duplicate to the submitter at the tenant review queue with three options per §22.12:
      - **Replace existing chunk:** call the RAG service’s `/replace/chunk/:id` endpoint (new — add to Build Prompt 09’s RAG API surface in this prompt). Preserves chunk ID, updates content.
      - **Add as new chunk with supersedes link:** insert as a normal new chunk, but record `rag_submissions.supersedes_chunk_id = matching_chunk_id` and on the RAG side annotate the new chunk’s metadata accordingly.
      - **Cancel re-submission:** mark `review_status='superseded'`; the new submission is dropped.

17. **Four-tab global review queue — §22.7.** Route `/admin/rag/global-review` (platform_super_admin and platform_compliance roles):
    - Tab 1 — **Auto-flagged:** `rag_submissions WHERE auto_flagged_for_global = TRUE AND review_status = 'approved' AND chunk_id_created NOT IN (SELECT tenant_chunk_id FROM rag_global_promotions WHERE demoted_at IS NULL)`. Default tab.
    - Tab 2 — **Tenant-promoted:** items where a tenant clicked “suggest for global” (add a `tenant_suggested_for_global BOOLEAN` column to `rag_submissions` in the migration). Low volume.
    - Tab 3 — **All approved chunks:** all approved tenant chunks with `global_relevance_score BETWEEN 0.3 AND RAG_INGEST_GLOBAL_RELEVANCE_AUTOFLAG_THRESHOLD`. Large; loads paginated.
    - Tab 4 — **Likely tenant-specific:** approved tenant chunks with `global_relevance_score < 0.3`. Largest; NOT loaded by default — admin must search to load.
    - Each item shows the chunk content, source, category, authority, the origin tenant, the global_relevance_score, and a “Promote” button (with notes textarea).
    - Notes captured in `rag_global_promotions.notes`.

18. **Promotion mechanics — §22.8.** `POST /api/admin/rag/promote/:submission_id`:
    - Wrapped in `withPlatformAdminAudit` with `reason = 'rag_chunk_promotion_to_global'`.
    - Calls the RAG service’s `/approve/global` endpoint (from Build Prompt 09) with the submission’s tenant chunk_id, originating tenant_id, and admin notes.
    - On success: insert a `rag_global_promotions` row with `tenant_chunk_id`, `global_chunk_id`, `promoted_by_user_id`, `promotion_source` (one of `auto_flagged | tenant_suggested | admin_browse | admin_one_off`), `notes`, `audit_log_id`.
    - The original tenant-scoped chunk remains intact. Both chunks reference each other via metadata on the RAG side (add this to Prompt 09’s `/approve/global` payload).
    - The promoted global chunk’s `origin_tenant_id` is preserved for forensic traceability — this is the linkage that survives even when the origin tenant later terminates (per Part 4 §15.14.3).

19. **Demote action — §22.8.** `POST /api/admin/rag/demote/:promotion_id`:
    - Wrapped in `withPlatformAdminAudit` with `reason = 'rag_chunk_demotion'`.
    - Two modes: `mode='to_tenant_scope'` (default) or `mode='hard_delete'`.
    - For `to_tenant_scope`: the global chunk’s scope is changed to `tenant` on the RAG side (via a new `/demote/chunk/:id` endpoint added in this prompt to the RAG service). If the origin tenant is currently terminated, the demoted chunk is subject to the 90-day post-termination tenant-scoped deletion from Part 4 Prompt 17 — effectively a delayed deletion.
    - For `hard_delete`: the chunk is removed from the corpus entirely.
    - `rag_global_promotions.demoted_at = NOW()`, `demoted_by_user_id = current_user`, `demote_audit_log_id = audit_log_id`.

20. **Browser extension behavioral spec — §22.9.** Build a `docs/browser-extension.md` documenting:
    - Floating button on supported sites (cruise line domains, partner sites).
    - Right-click → ‘Add to knowledge base’.
    - Captures URL, page title, selected text (or full page on demand).
    - Tags page automatically with detected entities.
    - OAuth-based auth (per-user, not per-extension-instance).
    - Manifest shape, content-script structure, OAuth flow.
    - The extension itself is NOT built in this prompt; the documentation enables a downstream build. Document this in MEMORY.

21. **Quality signals from submissions — §22.11.** Wire the four signals:
    - **AI quality score (Haiku-derived):** already produced in Stage 3 (`normalization_result.quality_score`); fed to the tenant review queue as a sort key and shown next to each item.
    - **Tenant approval rate:** computed as `approved / (approved + rejected)` per tenant per 30-day rolling window. Stored in a materialized view `tenant_rag_approval_rate_30d` refreshed nightly via Inngest cron. Fed to Part 6 §27 abuse signals (low approval rate is a signal of poor-quality submissions or wrong-content-source).
    - **Customer feedback on responses citing chunks:** already wired in Build Prompt 09’s authority loop; nothing new here.
    - **Duplicate detection rate:** counted in `rag_submissions` aggregation; fed to the same nightly cron.

22. **Failure modes — §22.13.** Confirm each failure mode is handled:
    - File parse error → `extraction_status='failed'`, tenant sees error, can retry or manual-text submit.
    - AI normalization timeout → retry with backoff (3 attempts). If still failing, queue for manual review without AI metadata.
    - PII zero-tolerance trigger → quarantine + alert (with aggregation per Task 12).
    - Duplicate detected → tenant decision per §22.12.
    - File too large → rejected at upload boundary with “suggest splitting”.

23. **Tests.**
    - Submission via each method (web UI, file upload, browser extension endpoint, iOS shortcut endpoint, manual, batch API) all produce a `rag_submissions` row and trigger the pipeline.
    - File extraction: PDF, DOCX, XLSX, PPTX, TXT, HTML, JPG all extract; an OCR-only image extracts via OCR; an unparseable file goes to `extraction_status='failed'`.
    - PII redaction regex: SSN-pattern content → quarantined; credit-card-pattern content → quarantined; name-only content → redacted with `[REDACTED]` markers; no-PII content → clean.
    - **Aggregation: first PII quarantine for a tenant alerts; second within 24h does NOT send a new alert but updates the existing one; 25 hours later a new alert is sent; 3 consecutive days with quarantine events emit the `rag_pii_recurring_pattern_detected` event.**
    - Normalization: a typical content blob produces the structured output; auto-flagged-for-global threshold respected.
    - Tenant review approve → chunk_id assigned on the RAG side; appears in global queue if auto-flagged.
    - Bulk approve safety prompt fires at > 10 items.
    - Duplicate detection: a re-submission of identical content surfaces the three options.
    - Global promote → `rag_global_promotions` row inserted, RAG-side global chunk created, audit_log row written.
    - Demote → promotion marked demoted; for `to_tenant_scope`, chunk scope changed; for `hard_delete`, chunk removed.
    - Demote of a terminated tenant’s promoted chunk: the chunk goes to the terminated tenant’s scope and is subject to the Part 4 Prompt 17 90-day tenant-scoped retention.

24. **Add to MEMORY.md at end of run:** (a) OCR provider chosen; (b) `rag_pii_recurring_pattern_detected` event has a `// TODO(part-6)` consumer awaiting Build Prompt 27; (c) browser extension and iOS Shortcut both documented but not built in this prompt — downstream operator tasks; (d) the `tenant_registry.rag_submit_daily_limit` and `rag_chunks_max` columns are confirmed nullable.

**Definition of done:**

- All six submission methods produce a row through the pipeline.
- A PII-zero-tolerance match quarantines without sending a duplicate alert within 24h; 3-day pattern triggers the abuse-signal event.
- Tenant admin can approve, reject, or edit-and-approve from the review queue.
- Platform admin can promote any tenant-approved chunk under the four-tab global review queue.
- Demote works in both `to_tenant_scope` and `hard_delete` modes.
- Re-ingestion offers replace / add-with-supersedes / cancel.
- Failure modes per §22.13 each route to the right state.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:migrations` all pass.

**After completion:** MEMORY.md entry per Task 24.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

# BUILD PROMPT 23 — Email infrastructure, pre-cruise series, in-app notifications

```
═══════════════════════════════════════════════════════════════
MODEL: claude-sonnet-4-6
SWITCH-BACK-AT-END: (already sonnet — no switch needed)
═══════════════════════════════════════════════════════════════
```

**Spec references:** Part 5 §23.1 (provider architecture — Resend), §23.2 (email log schema), §23.3 (CAN-SPAM compliance), §23.4 (pre-cruise email series — T-90/T-30/T-7/T-1 with carry-on callout and port info), §23.5 (companion web pages), §23.6 (email categories and rate limits), §23.7 (bounce and complaint handling), §23.8 (in-app notifications), §23.9 (Gmail inbound — optional). Depends on Build Prompt 18 (Resend + BrandedLayout template + email-from patterns), Build Prompt 19 (group invitation reminder cadence already in place).

**Prerequisite check:** Build Prompts 01–22 are committed. Resend is configured. BrandedLayout exists. Group invitations are already going out via Resend from Prompt 19.

**Goal:** Build the email log + suppressions tables, the full bounce/complaint handling, the four-email pre-cruise series with per-customer cached content generation including the T-1 carry-on callout and port info from RAG-seeded chunks, the companion web pages, the email category rate limits, the in-app notifications bell, and the optional Gmail inbound stub.

**Tasks:**

1. **Env vars.** Extend `apps/main/src/lib/env.ts`:
   ```
   RESEND_WEBHOOK_SECRET (required, secret) — for verifying Resend webhook signatures
   PRECRUISE_T90_HOURS_BEFORE (default 2160 — 90 days)
   PRECRUISE_T30_HOURS_BEFORE (default 720 — 30 days)
   PRECRUISE_T7_HOURS_BEFORE (default 168 — 7 days)
   PRECRUISE_T1_HOURS_BEFORE (default 24 — 1 day)
   ```

2. **Email log + suppressions schema — §23.2.** Migration `apps/main/supabase/migrations/0025_email_log.sql`:
   - `public.email_log` exactly per §23.2 schema. RLS: tenant-scoped via existing pattern.
   - `public.email_suppressions` exactly per §23.2. RLS: tenant-scoped.
   - Index: `email_log (tenant_id, to_email, sent_at)` for rate-limit queries; `email_log (resend_message_id)` for webhook lookups; `email_suppressions (tenant_id, email_address, reason)` for the suppression check.

3. **Email send helper.** Build `apps/main/src/lib/email/send.ts`:
   - `sendEmail({ tenant, to, template_id, variables, category, related_booking_id, related_group_id }): Promise<EmailSendResult>`:
     - Check `email_suppressions` for this `(tenant_id, to_email)` with relevant reason. For marketing emails: also check `unsubscribe_marketing` reason. For travel news: check `unsubscribe_travel_news`. If suppressed, return `{ status: 'suppressed', reason }` without calling Resend.
     - Check rate limits per §23.6 (Task 4).
     - Resolve the from-address per the tenant’s `email_send_pattern` (Pattern A tenant-Resend-key or Pattern B platform-CNAME — from Build Prompt 18).
     - Render the React Email template into HTML and plain-text.
     - Call Resend API with the rendered email.
     - Write `email_log` row with `resend_message_id` and `status='sent'`.
     - Return result.

4. **Rate limits per category — §23.6.** Build `apps/main/src/lib/email/rate-limit.ts`:
   - Transactional: always allowed.
   - Pre-cruise: bound to schedule, not subject to general limits.
   - Group invitation: 3 emails / 24h per invitee (already enforced in Build Prompt 19).
   - Marketing: 4 / month per contact. Counted from `email_log` where `email_category='marketing'`.
   - Travel news: weekly digest if subscribed; one per week per contact.
   - Helper `checkRateLimit({ tenant_id, to_email, category }): { allowed: boolean, reason?: string }`.

5. **CAN-SPAM compliance — §23.3.** Build into `BrandedLayout` (from Build Prompt 18):
   - Physical mailing address in every footer (from `tenants.mailing_address` populated in Build Prompt 16 onboarding profile stage).
   - Unsubscribe link on every marketing email pointing to `/email/unsubscribe?token=<HMAC-signed-token>` — token includes `{ email, tenant_id, category }`, validated server-side, and writes to `email_suppressions` on click.
   - “About this email” link to a preferences page (per-customer email preferences — added in this prompt’s schema if not already present).
   - Bulk emails identify themselves (header text on the email body).
   - From address per tenant identity (already handled in Build Prompt 18’s email-send pattern).
   - For tenants in `email_send_pattern='tenant_resend'` (Pattern A), the tenant’s Resend account handles SPF/DKIM; for Pattern B, the platform’s.

6. **Resend webhook handler — §23.7.** Endpoint `POST /api/webhooks/resend`:
   - Verify the webhook signature against `RESEND_WEBHOOK_SECRET`.
   - Parse the event type (`email.sent`, `email.delivered`, `email.bounced` with bounce type, `email.complained`, `email.opened`, `email.clicked`).
   - Look up the `email_log` row by `resend_message_id`.
   - Update fields accordingly:
     - `email.delivered`: set `delivered_at = NOW()`, `status = 'delivered'`.
     - `email.bounced` with `bounce_type='soft'`: retry up to 3 times over 24h (Inngest delayed job `email-soft-bounce-retry` at +6h, +12h, +24h).
     - `email.bounced` with `bounce_type='hard'`: set `status = 'hard_bounced'`, `bounced_at = NOW()`, `bounce_reason`, insert `email_suppressions` row with `reason='hard_bounce'`.
     - `email.complained`: set `status='complained'`, `complained_at = NOW()`, insert `email_suppressions` row with `reason='complaint'`.
     - `email.opened` / `email.clicked`: log engagement metric (no PII — just counts).

7. **Pre-cruise email series — §23.4.** Migration: add `public.pre_cruise_email_content` exactly per §23.4 schema.
   - `public.port_info_chunks` (RAG seed table for §23.4 port info): `port_code TEXT PK` (e.g., 'MIA', 'PCV'), `port_name TEXT`, `official_url TEXT`, `terminal_addresses JSONB`, `parking_info TEXT`, `transit_dropoff_info TEXT`, `arrival_advice TEXT`. Seed 17 rows for the §23.4 ports with placeholder content marked `// TODO(content)`.

8. **Pre-cruise email scheduling.** Inngest scheduled function `pre-cruise-email-scheduler` running hourly:
   - For each booking with `status='confirmed'` and `sailing_date IS NOT NULL`:
     - Compute `hours_before_sailing = (sailing_date - NOW()) / 1 hour`.
     - For each phase (`t_90`, `t_30`, `t_7`, `t_1`):
       - If `hours_before_sailing` is within ±1 hour of the phase’s target AND no `pre_cruise_email_content` row exists for this booking+phase: trigger Inngest event `precruise.email_due` with `{ booking_id, phase }`.

9. **Pre-cruise content generation.** Inngest function `precruise-generate-and-send`:
   - Triggered by `precruise.email_due`.
   - Read booking, contact, tenant context, conversation history (for personalization), customer memory.
   - Generate content per phase using Haiku (cached per §23.4 “Caching”):
     - **T-90 (Anticipation begins):** documentation reminder, passport check, pre-cruise to-dos; destination teasers, must-do experiences per port (from RAG), traveler stories, did-you-knows, suggested reads/videos.
     - **T-30 (Final prep window):** reservation reminders, check-in window, final payment; itinerary visualization, personalized recommendations from CRM, specialty experiences, pack inspiration, social proof.
     - **T-7 (Almost there):** AI-generated packing checklist, deck plans, ship highlights, cruise-line tips; embarkation visuals, first-day-aboard inspiration, port arrival expectations.
     - **T-1 (Tomorrow!):** **Carry-on essentials callout (CRITICAL — passport, paperwork, medications go in CARRY-ON, not checked).** Port info from `port_info_chunks` (NOT Google Maps — platform doesn’t know customer’s starting point). Weather for all stops (via a weather API integration; if not configured, omit and leave a `// TODO(weather-integration)` placeholder).
   - Write `pre_cruise_email_content` row with `generated_content` JSONB.
   - Render the email template `PreCruiseT90` / `T30` / `T7` / `T1` (each extending BrandedLayout) with the generated content.
   - Call `sendEmail` with category `'pre_cruise'`.
   - Update `pre_cruise_email_content.sent_at`.

10. **Carry-on essentials callout — §23.4 CRITICAL CONTENT.** The T-1 email template MUST include a prominent visual callout block:
    ```
    ┌──────────────────────────────────────────────────────────┐
    │  ⚠ CARRY-ON ESSENTIALS                                    │
    │                                                            │
    │  Pack these in your CARRY-ON, not your checked luggage:   │
    │  • Passport and travel documents                           │
    │  • Cruise paperwork (boarding pass, vaccination records)   │
    │  • Medications you take regularly                          │
    │                                                            │
    │  Checked luggage doesn't arrive at your cabin until        │
    │  hours later. Bring your essentials with you to board.     │
    └──────────────────────────────────────────────────────────┘
    ```
    The callout is hardcoded in the `T1` template — NOT AI-generated. This single piece of advice prevents the most common avoidable trip-ruining mistakes per the spec.

11. **Companion web pages — §23.5.** Route `/companion/[token]`:
    - HMAC-signed token (same key as group invitations from Build Prompt 19 OR a separate `COMPANION_TOKEN_HMAC_KEY` — document choice in MEMORY).
    - Decodes to `{ booking_id, phase }`.
    - Renders richer content: image galleries, embedded videos, detailed itineraries.
    - No auth required (token IS the auth).
    - Tenant branding via the tenant resolver middleware (custom domain or tenant subdomain).

12. **Bounce-retry Inngest function.** `email-soft-bounce-retry`:
    - Triggered by soft bounce events from the webhook handler.
    - At +6h, +12h, +24h: re-send via `sendEmail`. If a hard bounce occurs during retry, escalate to hard-bounce handling.

13. **In-app notifications — §23.8.** Migration: `public.notifications` per §23.8 schema. Index per spec.
    - `notifications` UI: bell icon in app header (existing layout from earlier prompts), shows unread count.
    - Categories: `booking_update`, `commission_settled`, `group_activity`, `escalation`, `system`.
    - Endpoint `POST /api/notifications/mark-read` and `POST /api/notifications/dismiss`.
    - Inngest events trigger notification inserts — e.g., a new booking confirmation, a commission settled per Build Prompt 15, group forum activity per Build Prompt 20.
    - Build a `createNotification({ user_id, tenant_id, category, title, body, link_url, icon })` helper.

14. **Gmail inbound — §23.9 (stub).** Optional, deferred-launch:
    - Endpoint `POST /api/integrations/gmail/connect` initiates OAuth flow with Gmail scopes (`gmail.modify`, `gmail.readonly`).
    - Stores encrypted refresh token using the `APP_ENCRYPTION_KEY_*` framework from Build Prompt 14.
    - Setting up Pub/Sub topic + push subscription requires GCP project setup — leave this as `// TODO(gmail-pubsub)` with a `docs/runbooks/gmail-inbound-setup.md` documenting the steps.
    - Inbound message handler stub at `/api/webhooks/gmail` accepts Pub/Sub push, parses email metadata, matches to existing contacts/conversations via the contact's email address. AI summary call to Haiku. Surface in CRM activity timeline.
    - Auto-reply: off by default, opt-in per tenant.

15. **Email categories & rate limits enforcement check — §23.6.** Verify every send path respects rate limits:
    - Transactional sends bypass rate limits.
    - Marketing send paths check `checkRateLimit` first.
    - Group invitation reminder cadence from Build Prompt 19 already enforces 3/24h.

16. **Tests.**
    - Email send happy path: `sendEmail` writes `email_log`, calls Resend, returns success.
    - Suppression: a hard-bounced email’s next send is suppressed.
    - Rate limit: marketing email #5 in a month to same contact is rejected.
    - Webhook verifies signature; on bad signature, rejects.
    - Bounce handling: soft bounce triggers retry; hard bounce writes suppression; complaint writes suppression.
    - Pre-cruise scheduler triggers at the right hour for each phase.
    - Pre-cruise content cached: re-running the same booking+phase reuses cached content, doesn’t re-call Haiku.
    - T-1 email contains the literal carry-on callout block.
    - Companion page renders with token validation; bad token → 404.
    - In-app notification creation and read/dismiss endpoints.

17. **Add to MEMORY.md at end of run:** (a) port content seeded with `// TODO(content)` placeholders for 17 ports — operator task; (b) weather API integration deferred — leave as `// TODO(weather-integration)`; (c) Gmail inbound Pub/Sub setup deferred to runbook; (d) companion token key (shared with invitations or separate).

**Definition of done:**

- Email send works through Resend with the right from-address per tenant pattern.
- Webhook handles delivered/bounced/complained correctly.
- Suppressions block subsequent sends to suppressed addresses.
- Pre-cruise scheduler fires at T-90, T-30, T-7, T-1 for each confirmed booking.
- T-1 email contains the carry-on essentials callout.
- Port info is read from RAG-seeded chunks (placeholders are fine).
- Companion web pages render with HMAC-token gating.
- In-app notifications bell shows unread count; mark-read and dismiss work.
- Gmail inbound stub exists with documentation for the Pub/Sub setup.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:migrations` all pass.

**After completion:** MEMORY.md entry per Task 17.

-----

# BUILD PROMPT 24 — Chat UI, tone matching with deterministic hate-speech denylist, anonymous + authenticated rate limits

```
═══════════════════════════════════════════════════════════════
MODEL: claude-opus-4-7
SWITCH-BACK-AT-END: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

**Why Opus:** The §24.5 deterministic hate-speech deny-list is non-negotiable: a heuristic check produces false negatives that screenshot badly. The deny-list contract has rules that no tenant config can weaken (no profanity-allow override, no persona override, no customer-mirroring) and an automatic human-escalation trigger after 3 consecutive regen-matches (which is the prompt-injection detector). Getting this wrong creates a public incident. The §24.8 anonymous chat three-identifier limit and §24.9 authenticated three-tier customer rate limit are the load-bearing abuse and customer-experience controls — single-tier scoping mistakes (tenant vs platform, per-customer vs per-session) silently change the business model from “customers must book to chat freely” to “customers chat forever at platform expense.” The §24.9 SQL function `resolve_customer_chat_caps` has six interacting inputs (tenant tier, override, platform defaults, future booking, bonus percentage, configurable ceilings/floors) — wrong precedence in any one of them changes who gets blocked when. The persona prompt augmentation at Soft1/Soft2 must stay in-character while being directive enough; the hard-limit must NOT use the persona at all (clearly platform-spoken). Getting any of these subtleties wrong is a UX or money-bleed problem in production.

**Spec references:** Part 5 §24.1 (layout — desktop and mobile), §24.2 (persistent AI disclosure), §24.3 (streaming with auto-scroll), §24.4 (message components), §24.5 (tone matching — 5-level scale with topic-aware modulation, customer override, supervisor tone_drift heuristic + deterministic hate-speech deny-list), §24.6 (persona switching in-conversation), §24.7 (message persistence), §24.8 (anonymous chat 3-identifier limit), §24.9 (authenticated customer 3-tier chat rate limit with booking bonus and persona prompt augmentation), §24.10 (escalation surface), §24.11 (memory indicators). Depends on Build Prompt 10 (personas and tools), Build Prompt 11 (supervisor with tone_drift stub — finalized here), Build Prompt 12 (customer memory), Build Prompt 17 (CCPA-deletion 30-day grace handling for customer-facing UX), Build Prompt 20 (forum chat — for the persona switching UX patterns).

**Prerequisite check:** Build Prompts 01–23 are committed. The persona system, supervisor framework, customer memory, and CRM are all in place. The chat conversation route (which already exists from earlier prompts) is what this prompt skins.

**Goal:** Build the production chat UI — desktop and mobile layouts, persistent AI disclosure banner, streaming with cursor-aware auto-scroll, message components with sources/feedback/copy, the five-level tone matching with topic-aware modulation and customer override, the supervisor `tone_drift` check’s heuristic layer AND the deterministic hate-speech deny-list, persona switching in-conversation, message persistence with drafts, the anonymous chat 3-identifier rate limit, the authenticated customer 3-tier rate limit with booking-bonus capacity and persona prompt augmentation, escalation surface, and memory indicators.

**Tasks:**

1. **Env vars.** Extend `apps/main/src/lib/env.ts`:
   ```
   ANON_CHAT_LIMIT_PER_SESSION (default 5)
   ANON_CHAT_LIMIT_PER_IP_24H (default 15)
   ANON_CHAT_LIMIT_PER_FINGERPRINT_24H (default 10)
   ANON_CHAT_LIMIT_PER_SESSION_UNDER_ABUSE (default 2)
   ANON_CHAT_LIMIT_PER_IP_UNDER_ABUSE (default 5)
   ANON_CHAT_LIMIT_PER_FINGERPRINT_UNDER_ABUSE (default 3)
   CUSTOMER_CHAT_SOFT1_CAP (default 20)
   CUSTOMER_CHAT_SOFT2_CAP (default 30)
   CUSTOMER_CHAT_HARD_CAP (default 40)
   CUSTOMER_CHAT_BOOKING_BONUS_PERCENT (default 100)
   CUSTOMER_CHAT_LIMIT_HARD_CEILING (default 200)
   CUSTOMER_CHAT_LIMIT_HARD_FLOOR (default 15)
   CUSTOMER_CHAT_WINDOW_DAYS (default 30)
   CUSTOMER_CHAT_SOFT1_COOLDOWN_DAYS (default 7)
   CUSTOMER_CHAT_SOFT2_COOLDOWN_DAYS (default 3)
   ```

2. **Chat layout — §24.1.** Build the chat shell:
   - Desktop: three-pane layout with sidebar (Active chat / History / Memory / Prefs), main chat area, and an optional right-side panel (e.g., RAG sources expansion).
   - Mobile: single-pane stack; drawer menu for history/memory/prefs; sticky compose bar at bottom; sticky disclosure at top.
   - The persistent AI disclosure banner from §24.2 rendered always at top: “AI-assisted chat — your conversations are reviewed for quality”.

3. **Persistent AI disclosure — §24.2.** The banner is a fixed component at the top of the chat surface (NOT a global header — it’s chat-specific). The banner is NOT dismissible. The text comes from `platform_settings.chat_ai_disclosure_text` (default per §24.2) so it can be revised without a code deploy.

4. **Streaming with auto-scroll — §24.3.** Build the streaming response component:
   - Server-sent events stream from the conversation route.
   - Auto-scroll behavior:
     - On scroll-stick detection (user is within 50px of bottom): keep scrolling as response streams.
     - On user-scrolled-up detection: don’t yank them down. Show a “New message” floating indicator at the bottom of the visible viewport.
     - Click on the indicator → smooth scroll to latest.
   - Implementation: use a `IntersectionObserver` on a bottom sentinel div; track whether the sentinel is in view.

5. **Message components — §24.4.** Build the message component with these elements:
   - Persona avatar (from tenant override or platform default — pulled from Build Prompt 10 + 18 persona tables).
   - Persona name (tenant override applies).
   - Sources indicator: if the message used RAG (from Build Prompt 21 retrieved_chunk_ids being non-empty), a subtle icon that expands to the `<MessageSources>` panel from Build Prompt 21.
   - Timestamp: hover for full timestamp; default relative format (“2 min ago”).
   - Feedback buttons: thumbs up / thumbs down on assistant messages. Down click opens an optional reason chooser.
   - Copy button: hover-visible; copies plain text.

6. **Tone matching — §24.5 five-level scale + supervisor tone_drift heuristic layer.** Build `apps/main/src/lib/chat/tone-resolution.ts`:
   - `resolveToneLevel({ tenant, persona, customer_memory, message }): { level: 1|2|3|4|5, source: 'tenant_default'|'persona_default'|'inferred'|'customer_override'|'topic_override' }`.
   - Inputs:
     - Tenant default tone level (`tenant_settings.persona_tone_max_level` default 3).
     - Persona’s base-tone inclination (`personas.base_tone_level` — add this column in this prompt’s migration if absent; default per persona seeded by Build Prompt 10).
     - Customer’s `customer_memories.rapport_tone_level` (set by customer override in §24.5 customer override section).
     - Conversation history with this tenant (older conversations soften the initial position).
   - Algorithm:
     1. Compute customer’s apparent style from their messages (formal vs casual — Haiku call once per conversation per topic shift; cached).
     2. Initial level: midpoint between customer’s apparent style and tenant default.
     3. Adjust upward gradually toward customer’s apparent level, capped at `tenant_settings.persona_tone_max_level`.
     4. Apply topic-aware modulation per the §24.5 table:
        - Medical/accessibility concern → stay at level 1-2 regardless of customer style.
        - Financial discussion → drop to level 2-3.
        - Cancellation/complaint/escalation → drop to level 1-2; increase empathy markers.
        - Booking confirmation/contract → drop to level 2.
        - Casual exploration → free at customer’s level.
     5. If `customer_memories.rapport_tone_level` exists (customer override per §24.5): apply as the floor unless topic-override is stricter.
   - The resolved level is rendered into the persona’s system prompt as part of Build Prompt 10’s system-prompt builder (this prompt extends the builder).

7. **Customer override — §24.5.** Detect tone-change requests in the user’s message:
   - “Be more casual” / “Lighten up” → bump `customer_memories.rapport_tone_level` up by 1 (capped at tenant max).
   - “Be more professional” / “Tone it down” → drop by 1.
   - “Cut the small talk” → drop to level 2; persist as a `rapport_tone_directive='direct'` flag in `customer_memories`.
   - The detection is via a deterministic phrase-match plus optional Haiku follow-up for ambiguous cases. Persistence is via the existing customer memory extraction pipeline from Build Prompt 12.

8. **Supervisor `tone_drift` heuristic layer — §24.5.** Implement the tone_drift check (stubbed in Build Prompt 11). Run on every AI response candidate:
   - **Heuristic detection (Haiku call):**
     - Detects responses far above tenant’s `persona_tone_max_level`.
     - Detects profanity when `tenant_settings.allow_profanity = FALSE`.
     - Detects mismatched seriousness (joking while customer is upset, indicated by negative sentiment or escalation keywords).
     - Detects sycophancy that reads as fake (independent of tone level).
   - On severe drift: regenerate with stricter tone instruction. Counts against the regen budget.

9. **Deterministic hate-speech deny-list — §24.5.** This is the non-negotiable layer. Build `apps/main/src/lib/supervisor/hate-speech-denylist.ts`:
   - Exports `checkHateSpeech(candidate: string): { match: boolean, term_hash?: string }`.
   - Loads the deny-list from `platform_settings.hate_speech_denylist` JSONB (array of strings). The array is platform-wide and can be augmented via `/admin/denylist` (platform_super_admin role) — Task 11.
   - For each term in the list: does the candidate contain it? Case-insensitive match with word-boundary detection (regex `\b{term}\b`). Context-aware exclusions: a term may have an `exclusions` array of regex patterns that match it but in safe contexts (e.g., an anatomical word that is a slur in some contexts but not in others) — if any exclusion matches the surrounding text, the term doesn’t trigger.
   - Returns `{ match: true, term_hash: sha256(term).slice(0, 12) }` on first match. The term itself is NEVER returned for audit purposes — only the hash. This protects the deny-list from being reverse-engineered.
   - The deny-list is platform-wide. Tenants cannot remove from it.

10. **Hate-speech match enforcement — §24.5.** Wire into the supervisor preflight chain (Build Prompt 11):
    - Run `checkHateSpeech` on every AI response candidate AFTER the heuristic tone_drift but BEFORE the message is sent to the customer.
    - On match: reject the response. Regenerate with the explicit prompt augmentation:
      > “Your previous response contained language we don’t allow. Please rewrite without [specific term redacted]. Keep the same intent and tone otherwise.”
    - **The regeneration counts toward the per-conversation regen budget per §10.1a.**
    - If THREE consecutive regenerations all match the lexical filter: auto-escalate to a human (the prompt-injection / persona-corruption detector per §24.5 Calls Worth Flagging). Set the conversation status to `escalated_to_human` per Build Prompt 11’s escalation flow. Alert platform admin via audit log with category `chat.three_consecutive_hate_speech_matches`.
    - Every match is logged to `audit_log` with `action = 'chat.hate_speech_lexical_match'` and `term_hash`. NEVER the term itself.

11. **Deny-list management — §24.5 “The deny-list”.** Platform-admin-only route `/admin/denylist` (platform_super_admin role):
    - View the current platform deny-list as a count and a CSV download (admin-only; auth-gated).
    - Add term: textarea + reason field. On submit: append to `platform_settings.hate_speech_denylist`. Audit row written with `action = 'denylist.updated', changes = { added_count: N, removed_count: 0 }` — note the audit captures counts only, not terms, per the §24.5 audit-by-hash rule.
    - Remove term: select by hash from the existing list (the hash is shown in the UI, not the term itself for safety) and remove. Same audit shape.
    - Quarterly review reminder cron `denylist-quarterly-review-reminder` (Inngest scheduled) every 90 days alerts the platform admin to review.

12. **Tenant supplemental deny-list — §24.5.** Pro+ tenants can add additional terms to their own supplemental list (additive to platform; cannot subtract):
    - `tenant_settings.supplemental_hate_speech_denylist` JSONB array.
    - The `checkHateSpeech` function loads both lists and matches against the union.
    - Tenant admin UI surface in `/tenant-admin/safety` (gated on Pro+ tier).

13. **Customer-side hate-speech informational handling — §24.5.** The lexical filter runs on AI output only. If a customer’s message contains slurs targeted at the AI or the tenant:
    - The supervisor may suggest a topic-level escalation per Build Prompt 11’s §10.3 path. Set a soft flag on the conversation rather than blocking the customer’s message.
    - The customer’s message is NOT blocked, redacted, or filtered. The platform does not censor customer input. The AI simply doesn’t reciprocate via the response-side lexical filter.

14. **Persona switching in-conversation — §24.6.** When the AI suggests a handoff (per Build Prompt 10’s §9.8 logic):
    - UI renders a confirmation card with the suggested persona name + reason: “I think Maya (our accessibility specialist) would be the right person for these questions. Want me to bring her in? [Yes, switch to Maya] [No, stick with Marcus]”
    - On Yes: `conversations.active_persona_id` updates. The new persona’s first message includes a brief context summary (generated via Haiku from the conversation so far).
    - On No: persona stays; the conversation continues.

15. **Message persistence — §24.7.** Build draft-saving:
    - As the user types, save to a debounced endpoint `PATCH /api/conversations/:id/draft` (or to localStorage as fallback).
    - On reconnect after network drop, reload state from server: messages from `messages` table, draft from the draft field.
    - On submit: clear the draft.

16. **Anonymous chat 3-identifier limit — §24.8.** Migration: `public.anonymous_chat_counters` per §24.8 schema:
    - Composite PK on `(identifier_type, identifier_value, tenant_id)`.
    - Cleanup cron `anonymous-chat-counter-cleanup` running nightly: hard-delete rows older than 7 days per the §24.8 schema comment (privacy/GDPR — IP retention bounded).

17. **Anonymous chat limit enforcement.** Build `apps/main/src/lib/chat/anonymous-limit.ts`:
    - `checkAnonLimit({ tenant_id, session_id, ip, fingerprint }): { allowed: boolean, hit_identifier_type?: 'session'|'ip'|'fingerprint' }`.
    - Query each identifier’s current count; compare against the configured cap (normal or under-abuse).
    - Return whichever identifier is most restrictive when blocked.
    - Increment counters on successful sends.
    - Fingerprint derivation server-side from request headers: hash of `(user-agent, accept-language, screen size from a client-supplied hint, canvas fingerprint from a client-supplied hint)`. Best-effort, not cryptographic. If client hints absent, fall back to header-based hash.

18. **Anonymous chat behavior at limit — §24.8.** When `checkAnonLimit` blocks:
    - The signup wall is rendered.
    - **The wall message does NOT specify which identifier was hit.** Per the §24.8 “don’t specify which limit was hit” rule.
    - Customer is invited to sign up. On signup completion, anonymous limits no longer apply; authenticated limit per §24.9 applies instead.

19. **Anonymous chat tenant abuse signal — §24.8.** When 3+ sessions from the same IP all hit the 5-message limit within 24h:
    - Emit Inngest event `chat.anonymous_chat_burst_detected` with `{ tenant_id, ip }`.
    - Build Prompt 27 in Part 6 consumes this for the `anonymous_chat_burst` abuse signal. At this prompt’s shipping time, the consumer is a stub (`// TODO(part-6)`).
    - This signal feeds platform admin alerts only; it does NOT directly throttle the tenant.

20. **Authenticated customer 3-tier chat rate limit — §24.9.** Migration: `public.customer_chat_counters` and `public.customer_chat_tenant_overrides` per §24.9 schema. Add the SQL function `public.resolve_customer_chat_caps(p_tenant_id UUID, p_user_id UUID)` per the §24.9 spec, exactly as written. Test the function with three scenarios:
    - Pro tier tenant with override, customer has future booking → uses override caps with bonus applied.
    - Starter tier tenant (no override path), customer has future booking → uses platform defaults with bonus applied.
    - Customer has no future booking → no bonus.

21. **Customer chat limit enforcement.** Build `apps/main/src/lib/chat/customer-limit.ts`:
    - On each message send (sync, before AI call):
      - Increment `customer_chat_counters.current_count` for `(user_id, tenant_id)`.
      - Call `resolve_customer_chat_caps`.
      - Check counter against resolved caps; determine if soft1, soft2, or hard threshold is crossed.
    - Soft1 (current_count >= soft1_cap AND < soft2_cap AND no soft1 nudge issued in last 7 days): set `soft1_last_issued_at = NOW()`; augment the persona’s system prompt for THIS turn with the §24.9 Soft1 prompt text (configurable via `platform_settings.customer_chat_soft1_persona_prompt`). The persona-augmentation is the in-character nudge — the response is normal AI output that includes the persona-styled focus redirect.
    - Soft2 (current_count >= soft2_cap AND < hard_cap AND no soft2 warning issued in last 3 days): same shape with the Soft2 text.
    - Hard (next message would push over hard_cap): block. **Do NOT call the AI.** Render the system-spoken message directly per §24.9 “At Hard limit”:
      - Clearly platform-spoken, NOT in-character.
      - Two CTAs: “Talk to a human” → standard escalation per §24.10; “View my bookings” → bookings list.
      - Customer’s essential operations (viewing bookings, account settings, group invitations) remain available.
      - Generate the audit summary via Haiku per §24.9 “Audit” subsection; store the audit_log row’s ID in `customer_chat_counters.hard_limit_summary_audit_id`.
      - Alert the platform admin with the structured payload per §24.9.
    - Counter recompute nightly cron `customer-chat-counter-recompute`: for each row, recount messages from the last 30 days. Safety net for drift.

22. **Customer chat tenant override surface — §24.9.** Pro+ tier tenants get `/tenant-admin/chat-limits`:
    - Inputs for soft1, soft2, hard caps and booking bonus percent.
    - Validation per §24.9: hard_cap between floor (15) and ceiling (200); soft1 < soft2 < hard; bonus 0–400.
    - Writes to `customer_chat_tenant_overrides`. Audited.

23. **Audit events — §24.9.** Every soft-tier crossing and every hard-limit block writes to `audit_log` per the §24.9 Audit subsection:
    - `customer_chat.soft1_nudge_issued`, `customer_chat.soft2_warning_issued`, `customer_chat.hard_limit_blocked`, `customer_chat.cap_override` (when admin manually raises a cap).

24. **Escalation surface — §24.10.** Build:
    - Customer can request human at any time:
      - Explicit ask via natural language (“I’d like to talk to a person”) — detected by entity extraction or a simple intent pattern.
      - “Talk to a human” button in conversation menu (`<EscalationMenu />`).
      - Implicit signals: supervisor detects frustration patterns (multiple thumbs-down in a row, repeated rephrasing, escalation-keyword density).
    - On escalation: create a topic-level escalation per Build Prompt 11’s §10.3 flow; customer sees a friendly transition message (“Thanks for chatting! I’m bringing in someone from the team — they’ll be in touch shortly.”); tenant agent receives notification via the §23.8 in-app notification path.

25. **Memory indicators — §24.11.** When the AI response uses memory (per Build Prompt 12’s customer memory retrieval), surface a subtle indicator on the message:
    - “Welcome back, Sarah! Last time you mentioned you were thinking about Alaska — should we pick up there?”
    - The memory indicator is rendered as part of the message’s body (the AI itself was prompted to reference memory naturally). The UI doesn’t need a separate badge — the prose IS the indicator.
    - Add a tooltip on the persona avatar for messages that used memory: “This response used context from your previous conversations.” Tenant-configurable: `tenant_settings.show_memory_indicators BOOLEAN DEFAULT TRUE`.

26. **Tests.**
    - Tone resolution: customer’s casual message + tenant tone_max=3 + persona base=2 → resolved level 3.
    - Customer override: “Be more casual” bumps `customer_memories.rapport_tone_level` by 1.
    - Topic override: medical-intent message forces level to 1-2 regardless of customer style.
    - Tone_drift heuristic: response far above max level triggers regen.
    - **Hate-speech deny-list: a candidate containing a denied term is rejected; regenerated; if 3 consecutive regens all match, conversation auto-escalates to human.**
    - **Deny-list audit: matched events log the term hash, NEVER the term.**
    - **Customer-side hate speech: customer’s slur in input does NOT block their message; AI’s response is filtered.**
    - Anonymous limit: hit session cap → signup wall; the wall doesn’t reveal which identifier hit.
    - Anonymous limit: 3 sessions from same IP all hit cap within 24h → `chat.anonymous_chat_burst_detected` event emitted.
    - **Customer chat limit: 21st message in 30d (no booking) → Soft1 persona augmentation injected; Soft1 cooldown prevents another nudge for 7 days.**
    - **Customer chat hard limit: 41st message → AI NOT called; system message rendered; Haiku summary written to audit_log; platform admin alerted.**
    - **Future booking bonus: customer with active future booking gets effective caps at +100% (40/60/80 defaults).**
    - **Customer cancelling their future booking removes the bonus on next message (lazy recomputation).**
    - Pro+ tenant override stored and respected; Starter tenant override-attempt rejected at API level.
    - Tenant override violating constraints (hard < 15, hard > 200, soft1 >= soft2, bonus > 400) rejected.
    - Persona switching: handoff suggestion → user clicks Yes → new persona’s first message includes summary.
    - Draft saving: typing saves; reload restores; submit clears.
    - Memory indicator tooltip appears on memory-using messages when `show_memory_indicators=TRUE`; hidden when FALSE.

27. **Add to MEMORY.md at end of run:** (a) hate-speech deny-list initial seed status — operator content task; (b) the `resolve_customer_chat_caps` SQL function is the single source of truth for cap resolution — any future cap logic changes go here; (c) the quarterly deny-list review cron is registered; (d) `chat.anonymous_chat_burst_detected` consumer is a `// TODO(part-6)` stub awaiting Build Prompt 27; (e) confirm the `customer_chat_counters.hard_limit_summary_audit_id` foreign key is set on every hard-limit block.

**Definition of done:**

- Chat UI renders desktop + mobile per §24.1.
- The persistent AI disclosure banner is non-dismissible.
- Streaming with cursor-aware auto-scroll works; “New message” indicator appears when user scrolled up.
- Tone matching resolves the right level for each combination of customer/tenant/persona/topic.
- The supervisor `tone_drift` heuristic catches drift and regenerates.
- **The deterministic hate-speech deny-list rejects matching responses, regenerates, audits by hash only, and auto-escalates after 3 consecutive matches.**
- The platform deny-list management page is gated to platform_super_admin.
- Anonymous chat 3-identifier limit blocks at session/IP/fingerprint independently; the most restrictive applies; the signup wall doesn’t reveal the identifier hit.
- Authenticated customer 3-tier limit: Soft1 augments persona; Soft2 augments persona more directly; Hard blocks AI call and renders system-spoken message with audit summary.
- The booking bonus is computed lazily on each message; cancelled bookings drop the bonus immediately.
- Pro+ tenant overrides work; Starter tenant override-attempts rejected.
- Persona switching works with first-message context summary.
- Memory indicator tooltip respects tenant setting.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:migrations` all pass.

**After completion:** MEMORY.md entry per Task 27.

```
═══════════════════════════════════════════════════════════════
END OF PROMPT — SWITCH BACK TO: claude-sonnet-4-6
═══════════════════════════════════════════════════════════════
```

-----

## End of Part 5 build prompts

**After all five prompts complete, you have:**

- Forum-style group chat with the fail-closed Haiku moderation contract: synchronous screen on submit, `pending_moderation` as a distinct state when Haiku is unavailable, retry job with optimistic locking and 5/15/60-minute backoff, 24-hour escalation to coordinator review, screening dimensions including credit-card zero-tolerance, bounded reactions, anonymity with role-aware reveal, coordinator tools (hide/unhide/pin/mute/lock), the strike system with recommendations-not-bans, and the post-sailing forum staying open.
- Booking-flow schema scaffolding in place even though the final UI is host-deferred: DOB-not-ages columns, estimated-DOB confirmation gate, multi-traveler contacts, sub-host tenant-of-record disclosure on review/confirmation/email/quote-accept, no-anonymous-bookings redirect with draft preservation, validation layers, cancellation triggering commission reversal.
- Full chat-time RAG path: entity extraction, query construction, retrieval with confidence floor + dedup + closed-promo gating + top-N cap, knowledge block formatted exactly per §21.4, citation instructions in persona prompt, source-transparency UI with tenant toggle, freshness caveats per category half-life, conflict handling via authority preference, no-result handling with don’t-fabricate instructions.
- The eight-layer hallucination defense fully implemented — the five preflight stubs from Build Prompt 11 (hallucination_risk, promise_detection, arithmetic_check, escalation_safety_net, plus the previously-deterministic ones) all real, with topic-specific guards (pricing cap, medical/legal forbidden, dates from tool only, loyalty cited only).
- The §21.10.1 quote pricing discipline: ESTIMATE quotes by default with the variance footer and the 7-day expiry; CONFIRMED quotes only when both 15-minute and price-lock conditions met; quote acceptance recording the customer-authorized variance with a full audit snapshot ID; booking-submit pausing to `pending_customer_reconfirmation` when the host’s price is outside variance.
- Full RAG ingestion pipeline: six submission methods (web UI, browser extension endpoint, iOS shortcut endpoint, file upload supporting eight file types, manual entry, batch API), four-stage normalization (extract → PII redact → AI normalize → auto-flag), PII zero-tolerance quarantine with the 24-hour aggregation contract emitting `rag_pii_recurring_pattern_detected` to feed Part 6 abuse signals on 3+ consecutive days, tenant review queue with bulk-approve safety prompt, four-tab global review queue under the revised model where platform admin can promote any tenant chunk, promotion mechanics wrapped in `withPlatformAdminAudit`, demote in both `to_tenant_scope` and `hard_delete` modes interacting with Part 4’s post-termination retention rules, re-ingestion with duplicate detection.
- Email infrastructure end-to-end: Resend integration with the email_log + suppressions tables, CAN-SPAM compliance throughout the BrandedLayout footer, the pre-cruise series (T-90/T-30/T-7/T-1) generating per-customer cached content via Haiku and the RAG-seeded port info chunks, the T-1 carry-on essentials callout hardcoded as the most important piece of content the platform sends, companion web pages with HMAC tokens, bounce and complaint handling with auto-suppression, per-category rate limits, in-app notifications, and the optional Gmail inbound stub with the Pub/Sub runbook documented.
- Production chat UI with desktop and mobile layouts, the persistent non-dismissible AI disclosure, streaming with cursor-aware auto-scroll, message components with sources/feedback/copy, the five-level tone matching with topic-aware modulation and customer override and the supervisor heuristic `tone_drift` check.
- **The deterministic hate-speech deny-list as a non-negotiable layer** — platform-wide, no tenant config can weaken, with by-hash audit logging that protects the list from reverse-engineering, and 3-consecutive-regen-match auto-escalation as the prompt-injection detector. Tenant supplemental list is additive only.
- The anonymous chat 3-identifier limit (session / IP / fingerprint) with the “don’t reveal which identifier hit” rule and abuse-burst event emission. The authenticated customer 3-tier rate limit (Soft1 / Soft2 / Hard) with the lazy-computed booking bonus, the persona prompt augmentation at soft tiers staying in-character, the clearly-platform-spoken hard-limit message with Haiku-generated audit summary, Pro+ tenant overrides under platform-enforced bounds, and the nightly counter-recompute safety net.
- Escalation surface for human handoff at any time. Memory indicators for memory-using AI responses.

**What’s deferred to later spec parts:**

- Privacy and data retention enforcement (§25 — Part 6). The §17.10 CCPA purge stub from Part 4 Prompt 17 still needs the full retention logic.
- Audit log structural finalization including reason enum extensions for the new events introduced in Part 5 (§26 — Part 6).
- Abuse monitoring subsystem listening to the events emitted from Part 5 prompts: `rag_pii_recurring_pattern_detected`, `chat.anonymous_chat_burst_detected`, and the soft-tier customer-chat events (§27 — Part 6).
- Observability and operational dashboards (§28 — Part 7).
- CI/CD pipeline including the staging-refresh contract that Part 4 Prompt 17’s propagation monitor depends on (§29 — Part 7).
- The final booking flow UI — deferred until launch host is selected per §20.
- Browser extension and iOS Shortcut concrete builds — endpoints exist, documented for downstream operator work.
- Photo support in forum (deferred to v7 per §19.11).
- Weather API integration in pre-cruise emails — left as `// TODO(weather-integration)`.

The prompts above add the **AI-mediated customer experience layer** on top of Parts 1–4’s foundation. After Part 5, the platform can take a customer from “first chat with the AI on a tenant’s site” through “booking with audited pricing discipline” to “forum chat with their travel group” to “pre-cruise emails with carry-on reminders” to “post-cruise read-only forum continuing the conversation” — all under platform-level guardrails for hallucination, PII, abuse, and customer-experience limits.
