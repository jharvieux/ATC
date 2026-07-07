# Kill-Switch Blast Radius Runbook

This runbook maps each operational kill switch to every behavior it disables, so you can predict the impact of flipping a flag before touching production configs.

## Overview

Kill switches are environment variables that disable features, crons, or integrations entirely. They live in `lib/env.ts` and are checked at runtime. Key principle: **always understand the secondary effects before flipping a switch**.

---

## Booking & Payout Flows

### `BOOKING_CRONS_DISABLED` (default: false)

**When true:** Disables ALL booking-related cron jobs that run via Inngest.

**Affected crons (disabled when true):**
1. `commission-split-on-received` — reconciles commission splits when a booking transitions to "received" status. Without this, commission rows don't get split between platform and subhost.
2. `payouts-mark-available` — transitions payout records from "pending_available" to "available" after the hold period. Without this, all payouts stay in hold indefinitely; subbosts can't withdraw.
3. `reconcile-statement-automated` — auto-finalizes payout statements. Without this, statement reconciliation stalls; payouts queue grows unbounded.
4. `payouts-execute-transfer` — executes the actual financial transfer. Without this, no transfers run, even if marked "available".
5. `bookings-stuck-submitting-reconcile` (Vercel cron, 5min cadence) — reverts bookings stuck in "submitting" state (§14.4 lock revert threshold = 5 min). **Critical: this is the safety net for the CAS lock in `/api/bookings/[id]/submit`** — if the route process dies between acquiring the lock and committing the result, the row stays locked forever. Users can't retry. Disabling this causes bookings to hang indefinitely if the submit route ever crashes.

**Blast radius:**
- **Revenue integrity:** No commissions are split → platform and subhost earn nothing on new bookings.
- **Payout availability:** All payouts frozen in hold state → subbosts can't withdraw earnings → cash-flow crisis.
- **User experience:** Bookings can get permanently stuck if submit route crashes → users must contact support for every hang.
- **Recovery complexity:** High. Reversing this requires manual reconciliation of all stuck rows and payout queue.

**When to use:**
- Rolling back a booking/commission/payout PR that introduced a bug.
- Emergency pause of payouts while investigating a discrepancy.

**⚠️ Caution:** Never leave this on for more than ~30 min. The stuck-submitting reconcile is a safety critical cron.

---

### `SUBHOSTING_CRONS_DISABLED` (default: false)

**When true:** Disables all custom-domain (sub-hosting) background jobs.

**Affected crons (disabled when true):**
1. `custom-domain-reverify` — Vercel cron that re-checks CNAME/TXT validity for custom domains. Without this, expired or misconfigured domains are never detected.
2. `custom-domain-txt-grace-sweep` — Vercel cron that auto-expires grace-period TXT challenges after max-age. Without this, temporary tokens never expire; TXT records pile up.

**Blast radius:**
- **Domain stability:** Misconfigured custom domains are never caught → tenants don't know their domain is broken until a customer complains.
- **Operational hygiene:** Grace-period records accumulate → DNS configuration drifts.
- **User impact:** None immediate, but stale config discovery is delayed.

**When to use:**
- Custom-domain feature is being redesigned or audited.
- Temporary pause while investigating a domain-reverify bug.

**Recovery:** Relatively low — re-enabling runs the jobs immediately on next cron window.

---

## General Pricing & Sourcing

### `APIFY_ADAPTER_ENABLED` (default: false)

**When true:** Enables dispatch of hotel/itinerary scraping jobs to Apify.

**Dependencies before dispatch:**
1. `APIFY_API_TOKEN` must be set (no token = feature unavailable at call site).
2. Individual per-line toggles must be true: `APIFY_ENABLED_RCL`, `APIFY_ENABLED_NCL`, `APIFY_ENABLED_PCL`, `APIFY_ENABLED_CEL`, `APIFY_ENABLED_COS`, `APIFY_ENABLED_CCL`, `APIFY_ENABLED_HAL`, `APIFY_ENABLED_MSC`, `APIFY_ENABLED_DSY`.

**Blast radius:**
- **Cost:** Apify charges ~$1–$2 per 1,000 results. Default run cap is `APIFY_MAX_ROWS_PER_RUN=2000`. With cost ceiling `APIFY_MONTHLY_BUDGET_USD_CEILING=500`, monthly spend is bounded.
- **Data freshness:** If disabled, general price-sourcing falls back to DIY scraper (`CRUISEMAPPER_DIY_INGEST_ENABLED`). Without Apify, DIY alone may not be sufficient for full market coverage.
- **No runtime failure:** Disabling Apify doesn't break the app; it just means less data is ingested.

**When to use:**
- Cost-control mode during budget-tight periods.
- Incident response if an Apify actor is misbehaving (flip the corresponding per-line toggle instead of `ADAPTER_ENABLED`).

**Per-line kill switches (D-088):**
Each of the 9 verified Apify actors has its own toggle:
- `APIFY_ENABLED_RCL` — Royal Caribbean Line
- `APIFY_ENABLED_NCL` — Norwegian Cruise Line
- `APIFY_ENABLED_PCL` — Princess Cruises Line
- `APIFY_ENABLED_CEL` — Celebrity Cruise Line
- `APIFY_ENABLED_COS` — Carnival Cruise Line
- `APIFY_ENABLED_CCL` — Cunard Cruise Line
- `APIFY_ENABLED_HAL` — Holland America Line
- `APIFY_ENABLED_MSC` — MSC Cruises
- `APIFY_ENABLED_DSY` — Disney Cruise Line

Use these to disable a single actor's dispatch (e.g., if one actor is rate-limited) without affecting the others.

---

### `CRUISEMAPPER_DIY_INGEST_ENABLED` (default: false)

**When true:** Enables nightly DIY scraper for CruiseMapper itineraries (text-only, no OpenAI embedding cost).

**Dependencies:**
1. `CRUISEMAPPER_DIY_USER_AGENT` should be set to identify the platform to CruiseMapper (so they can contact you before blocking).
2. `CRUISEMAPPER_DIY_RATE_LIMIT_RPS` (default 1.0 req/sec) caps request rate.

**Blast radius:**
- **Cost:** None from the DIY scraper itself; only manual network I/O.
- **Data quality:** Text-only scraping; no semantic itinerary embeddings. Useful for price freshness but not for semantic search.
- **Rate-limit risk:** If `CRUISEMAPPER_DIY_RATE_LIMIT_RPS` is too high, CruiseMapper may throttle or block the platform.

**When to use:**
- Supplement Apify when general pricing is insufficient.
- Cost-control mode if OpenAI embedding budget is tight.

---

### `CRUISEMAPPER_ITINERARY_INGEST_ENABLED` (default: false)

**When true:** Enables Apify CruiseMapper itinerary actor (expensive — runs OpenAI embeddings).

**Dependencies:**
1. `APIFY_ADAPTER_ENABLED` must be true (the CruiseMapper itinerary actor is gated by the Apify guard fence).
2. `APIFY_API_TOKEN` must be set.
3. `CRUISEMAPPER_ITINERARY_ACTOR_ID` (default: "crawlerbros/cruisemapper-cruises-scraper").

**Blast radius:**
- **Cost:** OpenAI API embeddings. Each itinerary embedding costs ~$0.01–$0.05 depending on length. With ~500–1000 sailings per month, this can reach $50–$500/month.
- **Data volume:** Itineraries are enriched with semantic embeddings for RAG retrieval. Disabling this means itineraries fall back to raw text search.

**When to use:**
- Semantic itinerary search is needed and budget is available.
- Disable if OpenAI embedding quota is exhausted.

---

## AI & LLM Flows

### `AI_GLOBAL_KILL_SWITCH` (env var, default: false) — ⚠️ NOT WIRED, see real mechanism below

**Verified 2026-07-07 (pre-pr-reviewer audit, PR #1644):** this env var is declared in `apps/main/src/lib/env.ts:380` and referenced only there and in one unit test (`env-boolean-coercion.test.ts`) — **no application code reads it.** It does not gate chat, price-watch, persona screening, RAG ingestion, memory extraction, or image generation. Treat any claim that this flag disables AI features as false until it is actually wired to a call site.

**The real AI kill switch is a DB row, not an env var:**

- **Mechanism:** `ai_kill_switch_state.global_paused` (Postgres table, single row, `id = 1`).
- **Enforced at:** `apps/main/src/lib/supervisor/run-supervisor.ts:122-152` (§10.6) — `runSupervisor()` reads this row on every AI turn and fails closed (escalates) if the read errors, or if `global_paused = true`.
- **Called from:** `apps/main/src/app/api/chat/route.ts`, `apps/main/src/app/api/public/chat/[token]/route.ts`, and `apps/main/src/lib/chat/run-generation-loop.ts` — i.e. **chat endpoints only**. It does NOT cover price-watch AI summaries, persona addendum screening, RAG ingestion, memory extraction, or AI image generation — those flows have no kill switch of any kind today (env or DB).
- **Managed via:** `POST /api/admin/ai-kill-switch` (`apps/main/src/app/api/admin/ai-kill-switch/route.ts`), platform-admin only, audited via `withPlatformAdminAudit`.

**Blast radius (of the real DB switch):**
- **Critical, but scoped to chat.** Flipping `global_paused = true` makes chat endpoints escalate every turn (user-facing: "Our AI is taking a brief break. A human will be in touch shortly.").
- Price-watch summaries, persona screening, RAG ingestion, memory extraction, and image generation are unaffected — they keep calling Anthropic/OpenAI even while chat is paused.
- **Recovery:** Flip `global_paused` back to `false` via the admin route; the supervisor picks it up on the next chat turn (cache TTL ≤ 30s per the route's own comment).

**When to use:**
- A widespread AI bug is affecting chat responses specifically.
- Anthropic API instability where you want a clean, controlled fallback message for customers rather than raw provider errors surfacing in chat.

**If you need to stop the OTHER five flows** (price-watch summaries, persona screening, RAG ingestion, memory extraction, image gen), there is currently no kill switch — see the follow-up issue filed for this gap.

---

### Per-Vendor AI Toggles (Not yet fully implemented, but planned)

The spec anticipates vendor-specific and per-tenant AI toggles (§28.15):
- `AI_VENDOR_ANTHROPIC_DISABLED` — disables Claude usage (fallback: OpenAI).
- `AI_VENDOR_OPENAI_DISABLED` — disables OpenAI (fallback: Claude).
- `AI_PER_TENANT_DISABLED` — per-tenant AI override (table-driven, not env vars).

These are not yet wired into code, but the structure is planned. **When implemented, they will allow graceful degradation instead of complete failure.**

---

### `RAG_INGESTION_PAUSED` (env var, default: false) — ⚠️ NOT WIRED

**Verified 2026-07-07 (pre-pr-reviewer audit, PR #1644):** declared in `apps/main/src/lib/env.ts:381` and never read anywhere else. Checked the full bodies of `apps/main/src/inngest/rag-extract-content.ts`, `rag-pii-redact.ts`, and `rag-normalize.ts` — none references this flag (or `RAG_INGESTION_PAUSED` under any name). There is currently **no way to pause RAG ingestion via env var** — flipping this in Vercel does nothing.

**If RAG ingestion needs to be paused today**, the only lever is disabling the individual Inngest functions in the Inngest dashboard (or removing them from the registration list in `apps/main/src/app/api/inngest/route.ts`) — there is no single flag. See the follow-up issue filed for wiring this properly.

**Related:** `RAG_INGEST_OCR_PROVIDER` controls whether OCR is available (tesseract, gcv, none) — this one IS read at the OCR call site; it's a genuine feature flag, not a pause switch, and is unaffected by the `RAG_INGESTION_PAUSED` gap above.

---

## OAuth & Authentication

### `OAUTH_GOOGLE_ENABLED` (default: true) — ⚠️ NOT WIRED

**Verified 2026-07-07 (pre-pr-reviewer audit follow-up, PR #1644):** same pattern as `OAUTH_MICROSOFT_ENABLED` above — declared in `env.ts` only. `apps/main/src/app/api/auth/oauth-initiate/route.ts:17` hardcodes `ALLOWED_PROVIDERS = new Set(["google", "azure", "facebook"])` regardless of this flag, and the signup page always renders the Google button. Setting this to `false` today does **not** remove Google login. Tracked in issue #428 (`OAuth sign-in providers` setup checklist references the flags but the code-side gating isn't built yet).

**What it's intended to do once wired:** disable Google OAuth login for users who only have that method configured.

---

### `OAUTH_MICROSOFT_ENABLED` (default: true) — ⚠️ PARTIALLY WIRED

**Verified 2026-07-07 (pre-pr-reviewer audit, PR #1644):**

- **What it DOES actually gate:** `apps/main/src/lib/env.ts:391` — a `superRefine` that requires `MICROSOFT_GRAPH_CLIENT_ID` + `MICROSOFT_GRAPH_CLIENT_SECRET` to be set at boot whenever this flag is `true`. This is a real, enforced boot-time check.
- **What it does NOT gate:** the actual Microsoft sign-in button/route. `apps/main/src/app/api/auth/oauth-initiate/route.ts:17` hardcodes `ALLOWED_PROVIDERS = new Set(["google", "azure", "facebook"])` — flipping `OAUTH_MICROSOFT_ENABLED=false` does not remove `"azure"` from that set, and the signup page (`apps/main/src/app/signup/page.tsx`) always renders the "Continue with Microsoft" button unconditionally. Setting the flag to `false` today would leave the login button live while pulling the required Graph credentials out from under it — worth confirming before relying on this flag operationally. Tracked in issue #428.
- **Calendar sync claim removed:** there is no Microsoft Calendar integration anywhere in this codebase. The only Microsoft Graph usage is `apps/main/src/lib/auth/microsoft-email-recovery.ts`, which recovers a login email address from Graph when Azure's OAuth claims omit one (§17.2) — unrelated to calendars. Per `specs/BuildPrompts/prompt-section-37.md:78`, calendar integration ("iCal feed, Google Calendar sync") is schema-ready but has no v1 implementation, and that's Google Calendar, not Microsoft — there's no Microsoft Calendar feature to break.

**Blast radius:**
- **Boot-time:** Setting `OAUTH_MICROSOFT_ENABLED=true` without the Graph creds set will fail deploy (safe, loud failure).
- **Login:** Setting `OAUTH_MICROSOFT_ENABLED=false` does NOT currently remove the Microsoft button or block the provider at `oauth-initiate` — see above.

---

### `OAUTH_FACEBOOK_ENABLED` (default: true) — ⚠️ NOT WIRED

Same pattern as `OAUTH_GOOGLE_ENABLED` above: `oauth-initiate`'s hardcoded `ALLOWED_PROVIDERS` set includes `"facebook"` unconditionally. Flipping this flag does not currently remove Facebook login.

---

### `OAUTH_APPLE_ENABLED` (default: false) — hedge: verify before relying on this

Unlike the other three OAuth flags, this one has a code-level guard worth noting: `oauth-initiate`'s `ALLOWED_PROVIDERS` set does NOT include `"apple"` at all today, so Apple sign-in is unreachable regardless of this flag's value — flipping it to `true` alone will not enable Apple login; the route needs a code change first (confirmed via `apps/main/test/unit/env/bp29-schema-discipline.test.ts`, which asserts no Apple-specific creds are declared, and issue #428, which lists Apple as needing a code change before dashboard setup). Per §17.1 this is intentionally deferred.

---

## Pricing & Rate Limits

### `PRICE_WATCH_NOTIFICATIONS_ENABLED` (default: false)

**When true:** Price-watch price-drop alerts are sent to subscribers (email + in-app).

**When false:** The daily Inngest job still runs and updates price-watch statuses (active → triggered), but **no notification is sent**. The UI shows the correct status, but the user doesn't get pinged.

**Blast radius:**
- **Cost:** Email / push notifications via Resend.
- **User experience:** Price-watch feature still works, but users don't know their target price was hit until they check the app manually.

**When to use:**
- Notification system is unavailable (Resend down).
- Cost control: disable notifications but keep the tracking active.

**Recovery:** Re-enable and re-notify users of price-drops that occurred while notifications were off (manual operation).

---

## Feature Toggles (Not Operational Kill Switches, but ops-relevant)

### `PHASE_2_CUSTOMER_BUG_FLOW_ENABLED` (default: false)

**When true:** Enables the Phase 2 customer bug-reporting flow (§32.15).

**Blast radius:**
- **Low:** Feature is dark by default. Enabling just activates the UI for bug submission.

---

### `SIGNUP_ENABLED` (default: true) — ⚠️ NOT WIRED

**Verified 2026-07-07 (pre-pr-reviewer audit follow-up, PR #1644):** declared in `apps/main/src/lib/env.ts:383`, referenced only there and in `env-boolean-coercion.test.ts`. `apps/main/src/app/api/auth/signup/complete/route.ts` and the `/signup` page do not check it. Flipping this to `false` today does not block new sign-ups.

**What it's intended to do once wired:** block new sign-ups while leaving existing users able to log in.

---

### `STRIPE_CONNECT_ONBOARDING_ENABLED` (default: true) — ⚠️ NOT WIRED

**Verified 2026-07-07:** declared in `env.ts:384` only. `apps/main/src/app/api/onboarding/connect/link/route.ts` (the Connect account-link creation route) has no reference to this flag. Flipping it to `false` today does not stop new Stripe Connect onboarding.

**What it's intended to do once wired:** pause new Sub-Host Connect onboarding while leaving existing Connect accounts unaffected.

---

### `MAINTENANCE_MODE` (default: false) — ⚠️ NOT WIRED

**Verified 2026-07-07:** declared in `env.ts:382` only, referenced in `env-boolean-coercion.test.ts` but nowhere in `apps/main/src/proxy.ts` (the routing middleware) or any route handler. There is no 503 maintenance page wired to this flag today — setting it to `true` has no effect on production traffic.

**What it's intended to do once wired:** return 503 to all non-staff requests during a migration or incident.

---

## Reference: env.ts Scan for Unstated Behaviors

Some env vars documented in `lib/env.ts` have call-site references that are NOT obvious from the comment:

- `ABUSE_OVERRIDE_REQUIRE_REAUTH` — documented as a toggle but some call sites use hardcoded defaults instead of reading this var. Audit `lib/abuse/` and API routes to verify it's actually wired.
- `ABUSE_OVERRIDE_*` — header in `lib/env.ts` notes: "spec'd vars are ignored at call sites". These need cleanup or documentation update: either wire them up or remove them.

**Action item (if not already filed):** Run a codebase audit to find all `process.env.ABUSE_OVERRIDE_*` references and document which are actually used vs. which are vestigial.

**Confirmed unwired as of 2026-07-07** (pre-pr-reviewer audit on PR #1644 + follow-up sweep — grepped every non-test, non-`env.ts` reference for each name): `AI_GLOBAL_KILL_SWITCH`, `RAG_INGESTION_PAUSED`, `OAUTH_GOOGLE_ENABLED`, `OAUTH_FACEBOOK_ENABLED`, `SIGNUP_ENABLED`, `STRIPE_CONNECT_ONBOARDING_ENABLED`, `MAINTENANCE_MODE`. Each is declared in `env.ts` with a schema default and covered by a boolean-coercion unit test, but has zero application-code call sites. `OAUTH_MICROSOFT_ENABLED` is a partial case — it gates a real boot-time credential check but not the login route. `OAUTH_APPLE_ENABLED` is moot — the login route doesn't recognize `"apple"` as a provider at all yet, wired or not. See each flag's own entry above for detail; this note exists so the next reader doesn't have to re-derive the same grep. **Filed as issue #1668** — wire these flags to real call sites or remove them from the schema; do not assume any of the above seven do anything until #1668 closes.

---

## Checklist: Before Flipping a Kill Switch

1. **Identify all affected flows** — grep `process.env.<SWITCH_NAME>` in the codebase to see where it's checked.
2. **Document the dependency chain** — does disabling this prevent a critical cron from running? Will it cascade?
3. **Check for stuck rows** — if you're disabling a reconciliation cron (like `BOOKING_CRONS_DISABLED`), scan the DB for rows that will be stuck (e.g., bookings in "submitting" state).
4. **Alert stakeholders** — notify ops, customer support, and engineering that the feature is disabled.
5. **Set a re-enable deadline** — don't leave production kill switches on indefinitely without a plan to re-enable.
6. **Log the change** — document when and why the switch was flipped in your incident log / ops wiki.

---

## Related Docs

- **Env configuration:** `lib/env.ts` (the source of truth for all kill switches)
- **Inngest registry:** `app/api/inngest/route.ts` (where all crons are registered)
- **Cron source files:** `lib/cron/` and `inngest/` (individual cron implementations)
- **Issue references:** #895 (booking stuck-submitting), #894 (custom domain deferral), #1668 (7 unwired kill-switch/feature-flag env vars — see "Reference: env.ts Scan" above), #428 (OAuth provider dashboard setup, incl. the Apple code gap)
