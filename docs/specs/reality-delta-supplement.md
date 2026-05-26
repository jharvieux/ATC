# Spec gap analysis — supplement to reality-delta.md

Findings from a systematic sweep of `specs/TechSpec/section-*.html` against current `dev` branch state (2026-05-25). Entries here are **gaps NOT already documented in `reality-delta.md`**.

The same usage rules apply: each entry tells you what to add to the spec OR what to build. `MEMORY D-NNN` refs cite decision history when relevant.

---

## Critical-path gaps (likely launch-blocking or audit-exposed)

### ~~§14.11 — 1099-NEC reporting~~ (NOT a gap — Stripe Connect handles it)
- **Spec quote (§14.11 in full):** "Stripe Connect Express handles 1099-NEC generation for sub-hosts ≥ $600/year. Platform's only responsibility: ensure all payouts flow through Connect (no off-platform payments). Stripe files with IRS and provides sub-host's copy via Connect dashboard."
- **Current state:** All payouts flow through Stripe Connect via `inngest/payouts-execute-transfer.ts` ✓. No platform-side 1099 code is needed or expected.
- **Original entry (incorrect):** Initial scan flagged this as a missing-code gap. The §14.11 text explicitly delegates issuance to Stripe Connect Express; nothing is missing.
- **Action:** None. Entry retained for paper trail.

### §32.3 — Tenant Admin Console Documentation (10 of 12 docs missing)
- **Spec:** 12 help-doc markdown files at `apps/main/content/help/`:
  - 01-getting-started.md ✓
  - 02-tenant-settings.md ✗
  - 03-branding.md ✗
  - 04-personas.md ✗
  - 05-crm.md ✗
  - 06-quotes-and-bookings.md ✗
  - 07-rag-content.md ✗
  - 08-usage-and-billing.md ✗
  - 09-team-and-permissions.md ✗
  - 10-customer-management.md ✗
  - 11-supervisor-and-quality.md ✗
  - 12-troubleshooting.md ✓
- **Current state:** 2 of 12 files exist, both thin (~50 lines each). The PDF/Word export pipeline (BP31 Phase C) is built but renders almost-empty deliverables.
- **Action:** Write the remaining 10 docs. This is content work, not engineering — but it blocks BP31 Phase C from being useful at launch.

### Tenant-facing settings UI gaps
The data layer + APIs exist, but tenants have **no UI** for:

| Surface | API | UI |
|---|---|---|
| Branding (logo, colors, custom domain) | `/api/tenant/branding`, `/api/admin/tenants/[id]/custom-domain` ✓ | `(tenant)/settings/branding/page.tsx` ✗ |
| Persona overrides + addendum | `/api/tenant/personas` ✓, screening cron ✓ | `(tenant)/settings/personas/page.tsx` ✗ |
| RAG submission review (§22.5) | `/api/rag/queue` ✓ | `(tenant)/crm/rag/queue/page.tsx` ✗ — only admin-side review exists |

These three are major: every Pro+ tenant needs branding + persona control to onboard meaningfully, and RAG-submission review is required before any tenant-submitted content can go global (§22.6).

<!-- §29.14 — DR posture runbook — CLOSED in this PR.
     docs/runbooks/disaster-recovery.md ships with the 9 scenarios from
     the §29.14 matrix, a backup-verification cadence section, and a
     recovery-rehearsal log structure for SOC 2 readiness. -->
### ~~§29.14 — Disaster Recovery Posture~~ (closed: `docs/runbooks/disaster-recovery.md`)

<!-- §30.7 — k6 scripts — CLOSED in this PR.
     tests/load/k6/ ships the 6 scenario scripts (chat-sustained,
     signups-burst, group-invite-blast, rag-retrieval,
     stripe-webhook-flood, multi-tenant-fanout) + a README with run
     instructions and prerequisites. CI does NOT run them per spec —
     they're out-of-band, manual, quarterly. -->
### ~~§30.7 — Load testing (k6 scripts)~~ (closed: `tests/load/k6/`)

---

## Spec-aligned but deferred / incomplete

### §19.10 — Post-sailing forum read-only mode (MISSING)
- **Spec:** Once a group's sailing_date passes, the group's forum transitions to read-only (no new posts, no edits).
- **Current state:** No code matches `post_sailed_mode`, `sailed_at.*forum`, or similar. The `groups-mark-sailed.ts` cron exists and marks groups sailed, but the forum POST route doesn't check that flag.
- **Action:** Add a `groups.sailed_at` check at `/api/forums/[forumId]/threads/[threadId]/messages` (POST) — return 410 Gone if sailed.

### §20.5 — DOB Confirmation Gate (MISSING)
- **Spec:** Booking submission requires the customer to confirm DOB for every passenger before the booking is submitted. The §11.5 "DOBs not ages" policy means we have an actual DOB on file, but the GATE re-prompts the customer at submit-time.
- **Current state:** `bookings/[id]/submit/route.ts` does NOT check any `dob_confirmed_at` field on passengers or contacts. The booking-flow UI may or may not surface the prompt — but the server-side gate is absent.
- **Action:** Add `passenger_dob_confirmed_at` (or similar) column to `booking_passengers`, enforce in submit handler.

### §17.10 — CCPA delete grace cron *(verify)*
- **Spec:** 30-day grace period before CCPA deletion fires; nightly cron processes graduates.
- **Current state:** `inngest/user-data-purge-after-grace.ts` exists. ✓ — but worth double-checking that the cron schedule is daily AND the grace-period math is correct after my recent privacy work. (Stryker survivors on this file's arithmetic suggest test gaps.)
- **Action:** Spot-check the cron's schedule + the grace_period_ended_at calculation against §17.10 exact wording.

### §26.5 — `audit_log` 7-year retention purge (MISSING cron)
- **Spec:** audit_log rows retained 7 years, then hard-deleted.
- **Current state:** Various other purge crons exist (`booking-commission-retention-purge`, `purge-parsed-documents`, `forensics-log-purge-cron`, `rag-rejected-items-purge`, etc.) — but **no `audit-log-retention-purge` cron**.
- **Action:** Add the cron. 7-year boundary: `DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '7 years'`. Should also write a meta-audit row "audit_log retention purge ran, N rows deleted".

### §30.6 — AI Evaluation Harness (design-only, not running)
- **Spec:** Claude-as-judge eval harness, regression detection > 5% verdict-change OR any safety-critical flip, contested-verdict review queue, 1% sampling daily, weekly drift trend alerts.
- **Current state:** `docs/evals/design.md` exists. **No CI hook, no harness code, no golden set, no cron**. MEMORY D-024 documented this as deferred.
- **Action:** Already in `reality-delta.md` §1 as cost-deferred. This supplement just confirms the design doc exists but execution is fully deferred.

### §13.9 — Host Adapter Health Monitoring (REACTIVE-ONLY — operator-confirmed 2026-05-26)
- **Spec:** Cron checks every active tenant_host_configs row's credential health, marks status (active / degraded / rejected). Banner surfaces.
- **Current state:** `lib/host-adapters/credential-health.ts` exists with the banner-resolution logic ✓. The BANNER is wired. Health is inferred reactively from decryption failures + Inngest job errors. NO active probe cron exists.
- **Decision (2026-05-26):** Stay reactive-only at launch. Rationale: host-adapter call volume is moderate; a broken credential surfaces within minutes via the next real call (every booking submit, commission reconciliation, etc.). A nightly active probe would add Inngest invocations + adapter API calls for tenants who'd surface the failure organically. Revisit if (a) host-adapter call volume drops such that real signal arrives slowly, or (b) a real incident proves the reactive path is too slow.
- **Action for spec update:** §13.9 needs `> **Status (2026-05-26):** Reactive-only at launch. Active probing deferred — see reality-delta.md §4 and MEMORY D-087.`

### §28.21 — Local development setup
- **Spec:** Documented `pnpm dev` flow + the env-vars-you-need-locally list.
- **Current state:** `docs/local-development.md` exists ✓ — but worth verifying it matches the .env.example file after BP29's env reconciliation work.
- **Action:** Quick audit of the doc vs. `apps/main/.env.example`.

### §29.5 — Supabase project setup runbook (MISSING)
- **Spec:** A runbook for setting up a fresh Supabase project (extensions to enable, RLS bootstrap, service-role grants, etc.).
- **Current state:** No `docs/runbooks/supabase-setup.md`. We have `local-development.md` which has some of this for local; no production-Supabase setup doc.
- **Action:** Write it. New environments + ops handoff need this.

---

## Smaller gaps worth tracking

### §10.5 — Supervisor Dashboard (UI exists, completeness unclear)
- Page at `apps/main/src/app/(admin)/supervisor/page.tsx` (244 lines). Worth a manual UX review against the §10.5 spec to confirm all dimensions render (sample category counts, regen budget exhaustion, kill-switch state, drift trend chart).
- **Action:** UX review pass; backlog any missing widgets.

### §32.9 — Interactive Bug Triage and Fixing
- `apps/main/src/app/(admin)/admin/help-triage/page.tsx` exists. Phase 2 readiness check at `phase-2-readiness/page.tsx`. **Probably built, worth a UX review** against the §32.9 contract (the "AI suggests fix → operator clicks accept" flow).

### §32.16 — Calls Worth Flagging
- Spec section enumerates known follow-ups for §32. Sweep these against MEMORY D-067/D-068 to verify each has a decision recorded.

### §26.11 — Penetration testing posture
- **Spec:** Annual pentest required pre-SOC 2.
- **Current state:** No runbook documenting how to scope / select firm / handle findings.
- **Action:** Doc-only. Write `docs/runbooks/pentest-scoping.md` before scheduling first engagement.

### §27.13 — Cross-section integration completeness
- **Spec:** Lists the integration points abuse monitoring must touch in §13, §22, §23, §26.
- **Current state:** Most are wired (cost tracking, RAG cap, email rate limit, group invitations). Worth a per-integration spot-check.

### §35 — Referral attribution completeness
- Migration `20260618000000_bp35_referral_attribution.sql` ✓
- Capture mechanism (UTM cookie, middleware) ✓
- Touch-table (`attribution_touches`) ✓
- **§35.4 Rolling Touch Table** — verify the rolling-window cleanup is wired (any cron pruning old touches?).
- **§35.6 Quote/Booking conversion touch fields** — verify both tables have the conversion attribution columns.

### §36 — Source-of-Business reporting
- Migration + routes exist ✓
- **§36.4 Campaigns table** + **§36.6 attribution_rollup materialized view** — verify both exist and the rollup-refresh cron runs.
- **§36.8 Export** — verify CSV export is wired.

### §37 — Tasks and sequences trigger fan-out
- Engine + Inngest job ✓ (covered in `reality-delta.md`)
- Already-known gap: pipeline-transition CRM endpoints don't call `triggerMatchingSequences()` yet. That's the missing piece.

### §38.8 — AI Co-Pilot for quote builder
- Quote builder + multi-option + PDF gen ✓
- **§38.8 AI Co-Pilot** — does the quote builder surface AI suggestions per-option (cabin recommendation, included perks, etc.)? Search for `quote.*suggest\|copilot`.

### §39.5 — Customer-side AI in trip-itinerary deliverable
- Itinerary PDF generator ✓
- **§39.5** — does the customer-facing trip page have an embedded chat for itinerary questions? Search for `itinerary.*chat\|trip.*ai`.

### §40 — Non-cruise line items completeness
- Schema + routes ✓
- **§40.5 UI / Agent Workflow** — the editor mounting was flagged in `reality-delta.md` as needing booking-detail page first. Same blocker applies here.

### §16.5 — Persona Overrides UI (Pro+ tiers)
- `tenant_persona_overrides` table ✓
- `persona_addendums` table ✓ + screening cron ✓
- **MISSING:** tenant-facing UI to author/edit. This is the same as the "tenant-side settings UI gaps" item above; calling it out separately because it's the §16.5 specific surface.

---

## Confirmed present (and likely fine)

For completeness — items I checked that are properly wired:

- §13.6 Fallback email adapter ✓ (`lib/host-adapters/fallback-email/`)
- §18.8 Group reminder cadence cron ✓ (`inngest/group-reminder-cadence.ts`)
- §18.10 Sailed-status cron ✓ (`inngest/groups-mark-sailed.ts`)
- §19.5 Forum reactions migration ✓
- §22.5 Tenant review queue API ✓ (the *tenant UI* is what's missing, see above)
- §23.4 Pre-cruise email Inngest jobs ✓
- §23.5 Companion web pages ✓ (`apps/main/src/app/companion/`)
- §24.11 Memory indicators (chat UI) ✓
- §26.6 Sentry monitoring ✓ (server + client config, PII scrubber)
- §26.10 Breach response runbook ✓ (`docs/runbooks/breach-response.md`)
- §27.10 Admin abuse dashboard ✓ (302 lines)
- §27.11 Tenant usage UI ✓
- §28.20 Secret rotation runbook ✓
- §29.8 Rollback runbooks ✓ (DB + application)
- §29.10 Sentry stack ✓
- §32.9 Bug triage console ✓ (admin-side)
- §33.6 RAG media assets ✓
- §33.8 Price-watch subscriptions ✓
- §35 Attribution capture migration + middleware ✓
- §38.6 Quote PDF generation ✓
- §39 Itinerary deliverable PDF gen ✓
- §40 Non-cruise line-items API ✓

---

## §33 Addendum — sweep findings (2026-05-25)

A focused audit of `specs/TechSpec/section-33-addendum-external-data-sources-and-media-assets.html` against current `dev` state. Items confirmed-present are not enumerated; entries below are the gaps surfaced.

### Code bugs fixed in this same PR

- **~~§33.7.2 #5 — no client-side 3-asset cap.~~** (Closed in `fix/section-33-hardening`.) `renderMessageContent.tsx` now caps rendered display-asset links at 3 per response regardless of how many markup tags the model emits. Excess markers drop silently. Test coverage added.
- **~~§33.8.3 — no expire-first sweep in `evaluate-price-watches`.~~** (Closed.) The cron now transitions watches with `sail_date < today` to status='expired' before any refresh, preventing wasted Apify spend on past sailings.
- **~~§33.8.3 — no freshness gate in `evaluate-price-watches`.~~** (Closed.) The comparator now reads `pricing_cache.fetched_at`, compares against `PRICE_FRESHNESS_FRESH_HOURS` (default 72h per §33.10), and skips watches whose cached price is stale. Stale prices can no longer trigger a notification. Pure-helper extraction (`lib/price-watches/freshness.ts`) with unit tests.

### Documented runtime decision (now in reality-delta.md §4)

- **§33.7.2 — hyperlink rendering, not inline `<img>`.** Was a deliberate MEMORY D-075 decision but absent from the delta doc. Now recorded in `reality-delta.md` §4 with the rationale and the spec-update action.

### Smoke-test results

- **§33.6.4 retrieve API extension — confirmed present.** `apps/rag/src/app/api/retrieve/route.ts` returns the `chunks[].related_asset_ids` + top-level `assets[]` arrays per spec, with tenant-scope filtering enforced and a per-request log of dropped IDs.
- **§33.9.3 monthly-budget pause priority — partially implemented.** Both the per-line Apify adapter (tracked-sailings path) and the CruiseMapper itinerary actor (general-pricing path) consult the same `apify_spend_ledger` rollup against `APIFY_MONTHLY_BUDGET_USD_CEILING`. There is **no priority ordering** between the two. The spec wants general-pricing refresh to pause *first* and tracked-sailings (subscriber-facing watches) to pause *last*. **Open gap:** introduce a sub-cap or pause-priority flag so a budget overrun on the monthly general-pricing run doesn't silently disable subscriber watches for the rest of the month.

### Decision-debt gaps (§33.12 "decide at build time" items that weren't decided)

These were flagged in §33.12 as "decided at build time" but no build-time decision was recorded. Each is an open decision that the operator owes.

- **§33.12 — Per-line actor coverage for Carnival, Holland America, MSC, Disney.** `apps/main/src/lib/pricing/line-routing.ts` ships these with placeholder `TBC/<line>` actor IDs and `enabled: false`. The spec called for build-time confirmation; no confirmation recorded. Subscriber-facing impact: customers on these four lines cannot create a price-watch today (UI correctly blocks creation, but the operator owes a decision on whether to commission actors).
- **§33.12 — UX for uncovered lines (Virgin, Viking, Oceania, Regent, Silversea, Seabourn).** Spec says the UI surfaces "no price-watch available" for these. Need to verify the price-watch creation flow surfaces this copy explicitly rather than just returning a generic error.
- **~~§33.12 — Sample-OCR evaluation gate.~~ DEFERRED 2026-05-26.** Per the spec's build order step 9, run Haiku vision on a 200-image sample of CruiseMapper deck plans + ship photos, measure uplift over text-only descriptions, decide whether to ship OCR. **Operator decision (2026-05-26): formally deferred.** Rationale: text-only chunks are already retrievable + ranked, OCR is incremental uplift. The eval itself is cheap (~$10-20 Haiku-vision) but the calibration time is the real cost. Re-evaluate once there's signal that customers ask deck-plan-specific questions at volume that text-only RAG can't satisfy. See MEMORY D-087.
- **§33.12 — Authority-override platform-admin UI.** Spec calls for a small admin surface to elevate or demote authority of batches of itinerary chunks (default `low`) and static-reference chunks (default `official`). Decision was "at build time"; no surface exists. Open decision: build it, defer it, or rule it out.

### Cross-cutting launch gates (not code gaps, but tracking)

- **§33.9.1 — Counsel ToS review (cruise-line scraping + CruiseMapper + image hot-linking).** Explicit launch-gate. Should be tracked alongside the §16/§17 counsel sign-offs in the deferred-for-legal list.
- **§33.9.3 — Token blast-radius mitigation.** Spec calls out that `APIFY_API_TOKEN` is account-level and the platform caps don't constrain the raw token. Action item: confirm whether Apify offers a scoped token shape, and either use it or document that the residual risk is accepted with the standard secret-rotation schedule as the only mitigation.

---

## Exhaustive spec sweep — overnight session 2026-05-26

A read-every-subsection pass across all 40 sections + addenda. Items
confirmed present are listed at the top of the supplement and not
repeated. Gaps surfaced below — fixed ones marked CLOSED with the PR.

### Gaps closed during the sweep

| § | Gap | Closed in |
|---|---|---|
| §6.7 | No `promo-state-reconcile` cron — stored `promo_status` could drift from `expected_promo_state()` | #213 |
| §6.7 | No `promo-state-drift-alert` cron — drift > 30 min should page | #213 |
| §6.12 | No retrieval-log aggregation cron — spec says detail kept 90d then aggregated, but neither aggregation nor purge existed | #213 |
| §11.7 | AI memory extraction wrote no `audit_log` rows (only customer/agent paths did) | #214 |
| §6.10 | Chat feedback never propagated to `rag.knowledge_chunk_feedback_events` — the §6.10 ranking factor was always 0 | #215 |

### Spec subsections marked TICK during the sweep

For each, code was located and matches spec:

- §1.4 / §3.6 Tenant resolution middleware
- §5.1.1 SECURITY DEFINER `search_path = ''` discipline (all 12 functions audited)
- §5.1.2 RLS 4-policy coverage (snapshot CI guards this)
- §7.9a Stripe webhook idempotency dedup (`stripe_webhook_events`)
- §7.1 / §17 Auth routes complete: callback, signup/complete, signout, /auth/me, /auth/consent-status, /auth/consent, /legal/:doc-type/current, /auth/transfer-session
- §8.3 Tenant registry sync (HMAC `tenant-events` + retry queue)
- §8.5 / §8.6 Ingest + approve endpoints
- §10.5a Supervisor sampling (`sampleForReview` called from `run-supervisor`)
- §11.5 DOB aging cron + re-prompt eligibility
- §11.6 Anonymous-to-authenticated session transfer
- §11.7 Customer self-edit + agent-edit audit (the gap was only AI extraction — closed in #214)
- §13.6 Fallback email adapter
- §14.7 Stripe Connect transfer idempotency contract
- §16.3.2 Custom-domain weekly re-verification cron
- §16.6 Persona addendum Haiku screen + periodic re-screen
- §16.7 Powered-by attribution (LegalPageAttribution + PoweredBy components)
- §17.2 Microsoft no-email prompt route
- §17.6 AI Liability Disclaimer (legal doc + persistent chat banner via `AIDisclosureBanner`)
- §17.10 CCPA delete grace cron (closed in #208 via `step.sleepUntil`)
- §18.3 Destination-relevant hero images
- §22.5 Tenant RAG review queue (UI shipped in PR #205)
- §22.7 Four-tab global review queue
- §23.4 Pre-cruise email scheduler + generate-and-send
- §23.9 Gmail inbound integration
- §24.4 Chat feedback endpoint (now propagating per-chunk in #215)
- §24.5 Tone matching + deny-list + supervisor tone_drift check
- §24.6 In-conversation persona switching
- §24.8 Anonymous chat counter cleanup cron
- §25.2 Retention crons (11 covered)
- §25.4a Anonymized notes UI
- §26.5 audit_log 7-year retention purge (closed in #208)
- §26.6 §26.6 monitoring crons (auth-failure, permission-denied, cross-tenant-rls-bypass, email-bounce-rate, ccpa-staging-propagation)
- §26.9 Vendor health probe
- §27.13 Cross-section abuse integrations (chat, RAG cap, email rate, group invitations all wired)
- §28.18 AI pricing cache refresh cron
- §28.20 Secret rotation runbook
- §32.9 Interactive bug triage — implemented as a Claude Code slash command at `.claude/commands/fix-bugs.md`, NOT as a runtime UI. Reclassified from gap to "implemented in an unexpected place".
- §32.10 Customer bug flow (`lib/help-ai/bug-intent-recognizer.ts`)
- §33.6.4 RAG retrieve API extension for assets
- §35.4 Rolling 10-touch trim (Postgres trigger on INSERT, no cron needed)
- §36.4/.6/.8 Campaigns + attribution_rollup MV + nightly refresh + CSV export
- §37 Sequence engine wired into CRM transitions (closed in #209)

### Gaps remaining (require a feature build, not fit for overnight)

- **§20.4 / §38.8 / §38.8.1 / §39.5 — Customer-facing AI chat panels.** The booking-flow co-pilot, quote-builder co-pilot, customer-side quote AI, and trip-page itinerary AI all need:
  - A customer-facing chat surface that renders without auth (token-bound)
  - New `/api/chat` extension or sibling that accepts a `context` payload (quote_id / booking_id) to inject into the system prompt
  - Persona resolution by booking/quote ownership
  - Anonymous-bound conversations + token-based RAG retrieval scoping
  - All four through supervisor preflight per §10
  - **Recommend a dedicated build prompt.** Reuse the existing chat infrastructure; add a thin "customer-context-loaded" wrapper. ~2 days of work; needs browser testing.

- **§30.6 AI behavior evaluation harness.** Cost-deferred per `reality-delta.md §1`. Design at `docs/evals/design.md`.

- **§22.4 tolerable-PII Haiku redaction.** Cost-deferred per `reality-delta.md §1`. Stage 1 (zero-tolerance regex) works; Stage 2 stub.

- **§32.6.5 / §32.13.2 Help-AI confidence scoring + screenshot PII detector.** Cost-deferred.

- **§13.9 Host-adapter active health probing.** Code uses reactive-only inference today; spec implies active probing. Operator call needed: keep reactive (cheaper) or add nightly probe.

### Process notes — auditor's flagged areas (require operator review)

- The §11.5 estimation aging cycle runs *yearly* (>365 days since last re-prompt). Re-confirm that's the intended cadence — could be punishingly slow for the customer who entered an estimated DOB.
- The §33.9.3 budget-split default (80% general / 20% tracked-sailings) was a reasonable engineering choice but the spec doesn't dictate the percentage. Operator may want different defaults once real Apify spend lands.
- §10.6 kill-switch state is shown on the new §10.5 dashboard (#208) — but the auth/permission model for who can flip the kill switch isn't explicit in spec. Today: any user with `assertPlatformAdmin` access can.

---

## Process notes

Same conventions as `reality-delta.md`:
- This file is **append-only**; do not edit prior entries without explicit approval.
- When a gap is closed, leave the entry with a `> **Closed YYYY-MM-DD in #PR**` callout rather than deleting — preserves history.
- New gaps surfaced after a feature lands belong in this supplement, not in `reality-delta.md` (which is reserved for deviations from the original spec text).
