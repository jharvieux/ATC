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

### `AI_GLOBAL_KILL_SWITCH` (default: false)

**When true:** Disables ALL AI-powered features platform-wide.

**Affected flows:**
1. Chat endpoints — all chat requests return a fail-closed error.
2. Price-watch AI summary generation — price watches show raw prices, no AI summary.
3. Persona addendum screening (Haiku contract) — tenants lose AI personality verification.
4. RAG ingestion pipelines — document processing stalls (no extraction, no normalization, no embedding).
5. Memory extraction — user memory stays static.
6. AI image generation — group hero images fall back to solid color or default.

**Blast radius:**
- **Critical:** This is the nuclear option. Everything that depends on Claude or OpenAI stops.
- **User experience:** App still functions but becomes a "dumb" data store — no personalization, no summaries, no recommendations.
- **Recovery:** Re-enabling immediately resumes all pipelines.

**When to use:**
- Anthropic API is down or quota exhausted.
- Emergency response to a widespread AI bug affecting all tenants.

**Recovery:** Set to false and restart the app.

---

### Per-Vendor AI Toggles (Not yet fully implemented, but planned)

The spec anticipates vendor-specific and per-tenant AI toggles (§28.15):
- `AI_VENDOR_ANTHROPIC_DISABLED` — disables Claude usage (fallback: OpenAI).
- `AI_VENDOR_OPENAI_DISABLED` — disables OpenAI (fallback: Claude).
- `AI_PER_TENANT_DISABLED` — per-tenant AI override (table-driven, not env vars).

These are not yet wired into code, but the structure is planned. **When implemented, they will allow graceful degradation instead of complete failure.**

---

### `RAG_INGESTION_PAUSED` (default: false)

**When true:** Pauses RAG content extraction, normalization, and embedding pipelines.

**Affected Inngest functions:**
1. `ragExtractContent` — stops extracting text/structured data from uploaded documents.
2. `ragPiiRedact` — pauses PII redaction checks.
3. `ragNormalize` — stops semantic normalization of chunks.
4. RAG embedding tasks — documents don't get embedded, can't be retrieved via RAG.

**Blast radius:**
- **Data loss risk:** None — documents are stored but not indexed. Re-enabling resumes processing from where it left off.
- **User experience:** Uploaded documents don't appear in RAG search results until re-enabled.
- **Recovery:** Low. Re-enabling queues all backlogged documents for processing.

**When to use:**
- RAG extraction is buggy or consuming too many API tokens.
- Temporary pause while investigating PII redaction failures.
- Cost control: disable to avoid embedding costs while diagnosing a surge.

**Related:** `RAG_INGEST_OCR_PROVIDER` controls whether OCR is available (tesseract, gcv, none). Unlike a kill switch, this is a feature flag that disables OCR entirely, not a pause.

---

## OAuth & Authentication

### `OAUTH_GOOGLE_ENABLED` (default: true)

**When false:** Users cannot log in via Google OAuth.

**Blast radius:**
- **User login:** Users with only Google OAuth configured lose access (unless they use another method or reset password).
- **No revenue impact:** Authentication-only; doesn't affect features.

**When to use:**
- Google OAuth discovery attack or abuse spike.
- Operator is rotating credentials.

---

### `OAUTH_MICROSOFT_ENABLED` (default: true)

**When false:** Users cannot log in via Microsoft OAuth. Also blocks Microsoft Graph integration (if enabled).

**Dependency:** When true, `MICROSOFT_GRAPH_CLIENT_ID` and `MICROSOFT_GRAPH_CLIENT_SECRET` must be set (enforced at boot).

**Blast radius:**
- **User login:** Users with only Microsoft OAuth lose access.
- **Calendar sync:** If any tenant uses Microsoft Calendar integration, it breaks.

---

### `OAUTH_FACEBOOK_ENABLED` (default: true)

**When false:** Users cannot log in via Facebook.

---

### `OAUTH_APPLE_ENABLED` (default: false)

**When true:** Users can log in via Apple OAuth.

**Blast radius:** Low. Only affects new sign-ups and existing users who haven't enrolled Apple auth.

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

### `SIGNUP_ENABLED` (default: true)

**When false:** New sign-ups are blocked. Existing users can still log in.

**Blast radius:**
- **Acquisition:** No new customers can register.
- **No impact on existing tenants.**

**When to use:**
- Onboarding system is under maintenance.
- Platform is at capacity (rare).

---

### `STRIPE_CONNECT_ONBOARDING_ENABLED` (default: true)

**When false:** Subbosts cannot initiate Stripe Connect onboarding.

**Blast radius:**
- **Revenue split:** New subbosts cannot receive payouts. Existing subbosts with active Stripe accounts still receive transfers.

---

### `MAINTENANCE_MODE` (default: false)

**When true:** App returns 503 Service Unavailable to all requests except platform staff.

**Blast radius:**
- **Complete outage for customers.**
- **Immediate and obvious to users.**

**When to use:**
- Database migration in flight.
- Major infrastructure incident.

---

## Reference: env.ts Scan for Unstated Behaviors

Some env vars documented in `lib/env.ts` have call-site references that are NOT obvious from the comment:

- `ABUSE_OVERRIDE_REQUIRE_REAUTH` — documented as a toggle but some call sites use hardcoded defaults instead of reading this var. Audit `lib/abuse/` and API routes to verify it's actually wired.
- `ABUSE_OVERRIDE_*` — header in `lib/env.ts` notes: "spec'd vars are ignored at call sites". These need cleanup or documentation update: either wire them up or remove them.

**Action item (if not already filed):** Run a codebase audit to find all `process.env.ABUSE_OVERRIDE_*` references and document which are actually used vs. which are vestigial.

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
- **Issue references:** #895 (booking stuck-submitting), #894 (custom domain deferral)
