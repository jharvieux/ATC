# Spec gap punch list

Working list of open gaps from `reality-delta.md`, `reality-delta-supplement.md`, and `reality-delta-supplement-2.md`. Items here are things to **close** (build, decide, or wait on) — not spec-text edits (those live in `reality-delta.md` and get applied in a future spec-sync pass).

**As of 2026-05-27 (post-P1/P2 close-out).**

> **Reconciled 2026-05-29 — open gaps now tracked as GitHub issues #421–#430.** This list was re-checked against `dev`. Every item the inline rows below mark 🚧 *queued* / 🟡 *in-flight* has since **merged**; those rows are preserved as the 2026-05-27 snapshot (history), so use the two tables in this section for current status.

### Still open → issue

| Punch-list item | Issue | Note |
|---|---|---|
| F4 — streaming-branch persona tools | [#421](https://github.com/jharvieux/ATC/issues/421) | unblocked |
| #57 §17.4 — legal docs from table + consents | [#422](https://github.com/jharvieux/ATC/issues/422) | + attorney sign-off / open-questions notes |
| F7 — real persona-tool handlers | [#423](https://github.com/jharvieux/ATC/issues/423) | `search_host_inventory` blocked on BP14 |
| #58 / F8 §20.2 — booking flow Stages 2/3 | [#424](https://github.com/jharvieux/ATC/issues/424) | needs `booking_passengers` + add-ons tables |
| #62 — `local-development.md` vs `.env.example` | [#425](https://github.com/jharvieux/ATC/issues/425) | #60/#61 runbooks already exist |
| P3 #31–36 — cost-deferred AI surfaces | [#426](https://github.com/jharvieux/ATC/issues/426) | intentional opt-in stubs |
| P4 #37–55 — external-blocked (legal/operator) | [#427](https://github.com/jharvieux/ATC/issues/427) | umbrella |
| §28.9 — OAuth sign-in provider setup | [#428](https://github.com/jharvieux/ATC/issues/428) | manual op step (instructions inline) |
| #47 §23.9 — Gmail inbound provisioning | [#429](https://github.com/jharvieux/ATC/issues/429) | runbook exists |
| #46 / #52 / Vercel / Stripe / Supabase / admin-seed | [#430](https://github.com/jharvieux/ATC/issues/430) | operator provisioning checklist |

### Merged / done since this snapshot (status corrections)

| Item | Was | Now |
|---|---|---|
| #15 §10.6 per-tenant kill switch | 🚧 PR #340 queued | ✅ merged #340 |
| #17 downline rename · #18 SSE Last-Event-ID | 🚧 PR #342 | ✅ merged #342 |
| #19 Idempotency-Key header | 🚧 PR #344 | ✅ merged #344 |
| #20 customer-AI phases 2+3 | 🚧 PR #351 | ✅ merged #351 |
| #33 §22.4 Stage-2 PII batch path | 🚧 #363 | ✅ batch path merged #368 (Haiku call still cost-deferred → #426) |
| #56 §9.6 persona tools | 🟡 PR #358 | ✅ merged #358 |
| #58 §20.2 booking Stage 1 | 🟡 PR #359 | ✅ Stage 1 merged #359 (Stages 2/3 → #424) |
| #60 supabase-setup · #61 pentest-scoping runbooks | BUILD-doc | ✅ both exist (181 / 203 lines) |
| F1 supervisor via public chat | 🟡 PR #357 | ✅ merged #357 |
| F5 contact_id threading | open | ✅ merged #370 |
| F6 ai_tool_calls audit table | open | ✅ merged #369 |
| F9 dependabot #329/#330 | needs investigation | ✅ both closed |

---

## Conventions

| Column | Meaning |
|---|---|
| `§` | Spec subsection ref |
| **Action** | `BUILD` (engineer it) · `DECIDE` (operator picks one of the listed options) · `WAIT` (blocked on external party) · `FIX` (audit follow-up bug) · `CONTENT` (non-engineering content work) |
| **Effort** | S = under 1 day · M = 1-3 days · L = 4-10 days · XL = multi-week |
| **Source** | `delta` = original reality-delta.md · `s1` = supplement · `s2` = supplement-2 |
| **Status** | `closed` · `open` · `partially-closed` · `blocked-on-X` |

Closed items are kept with their PR reference rather than deleted, so a future reader can see what shipped and why.

---

## P1 — close before launch (customer / money / compliance impact)

**All P1 items closed.** ✅

### Real-money / data-integrity

| # | § | What | Status |
|---|---|---|---|
| 1 | §15.12 | Sandbox mode wired through chat/bookings/commissions | ✅ Closed in #331 |
| 2 | §18.5 | Invite first-use TOCTOU CAS guard | ✅ Closed in #332 |
| 3 | RAG JWT | kid→PEM mapping for zero-downtime rotation | ✅ Closed in #333 |
| 4 | §25.4a | CCPA purge nulls `conversations.user_id` | ✅ Closed in #334 |
| 5 | §17.5 | Email blast on legal-doc version update | ✅ Closed (verified already wired in `/api/admin/legal-docs/route.ts:143-175`) |

### Customer-facing UX

| # | § | What | Status |
|---|---|---|---|
| 6 | §11.3 | Customer `/settings/memory` page | ✅ Closed in #337 |
| 7 | §25.3 | Customer `/settings/profile` page | ✅ Closed in #337 |
| 8 | §11.6 | Customer `/settings/conversations` page | ✅ Closed in #337 |
| 9 | §18.10 | Group "sailed" read-only mode enforced | ✅ Closed in #335 (`assertGroupNotSailed`) |
| 10 | §20.5 | DOB confirmation gate | ✅ Closed (verified already wired at `bookings/submit:109` via `assertNoEstimatedDOBs`) |

### Security / compliance

| # | § | What | Status |
|---|---|---|---|
| 11 | §34.3.1 | Document virus scanning | ✅ Closed in #336 — risk acceptance documented in `docs/runbooks/upload-virus-scanning-risk-acceptance.md` |
| 12 | §32.3 | Help docs (was: 10 of 12 missing) | ✅ Closed in #345 — `01-getting-started.md`, `12-troubleshooting.md`, `settings-ai-mode.md` rewritten for non-technical travel agents; other docs were already present |

---

## P2 — spec promises not implemented

**All P2 build items closed or queued.** ✅

### Easy wins

| # | § | What | Status |
|---|---|---|---|
| 13 | §9.3 | Anthropic prompt caching | ✅ Closed in #338 (via `buildSystemArg`) |
| 14 | §24.7 | Chat draft autosave | ✅ Closed in #339 |
| 15 | §10.6 | Per-tenant kill switch | 🚧 PR #340 queued (`ai_paused_by_platform` column wiring) |

### Decision-required (spec edit vs build)

| # | § | What | Status |
|---|---|---|---|
| 16 | §4 / §16.4 | Custom email-from domain verification | ✅ Closed in #343 (Resend domain registration + verify) and #346 (verification card UI) |
| 17 | §4 / §1.5 | "Downline (sub-hosts)" matrix row rename | 🚧 PR #342 queued — operator decision: rename to "Subcontractor tracking (internal)"; spec edit recorded in `reality-delta.md` appendix |
| 18 | §7.9 / §9.9 | SSE `Last-Event-ID` reconnect | 🚧 PR #342 queued — operator decision: strike from spec; EventSource browser-level auto-reconnect IS the actual contract |
| 19 | §7.9 | `Idempotency-Key` HTTP header for client mutations | 🚧 PR #344 queued (`request_idempotency` table + 24h cache + purge cron) |

### Customer-facing AI panels

| # | § | What | Status |
|---|---|---|---|
| 20 | §20.4 / §38.8.1 / §39.5 | Customer-facing AI on booking flow, customer quote view, trip itinerary | ✅ Phase 1 closed in #347 (booking flow with `<CustomerContextChatPanel>` + server-resolved context). 🚧 PR #351 queued for Phases 2+3 (token-gated `/api/public/chat/[token]` + new `/q/[token]` page + AI mount on `/i/[token]`). **Documented gap:** supervisor not wired through `/api/public/chat/[token]` — mitigated by strong system-prompt ground rules + read-only context, see D-102. |

### Tenant admin UI gaps

| # | § | What | Status |
|---|---|---|---|
| 21 | §16 | Tenant branding UI | ✅ Closed in #346 (stale canonical domain string fixed + `EmailDomainVerificationCard` added; supplement-2 had flagged the page as incomplete but the page was already 90% there) |
| 22 | §16.5 / §9 | Tenant persona overrides + addendum UI | ✅ Verified complete (`(tenant)/settings/personas/page.tsx` — 371 lines, full implementation with addendum screening status) |
| 23 | §22.5 | Tenant RAG submission review queue UI | ✅ Verified complete (`(tenant)/crm/rag/queue/page.tsx` — 318 lines: filters, bulk-approve with >10 confirmation, per-item approve/reject + reason, preview expand, PII redacted badge, auto-flagged-for-global badge) |

### Editor / co-pilot UI wiring

| # | § | What | Status |
|---|---|---|---|
| 24 | §39.7 / §40.5 | Booking detail page + mount 3 editor panels | ✅ Closed in #349 (`(tenant)/crm/bookings/[id]/page.tsx` + GET endpoint + 3-tab layout mounting `ItineraryEditor` / `ResourcesEditor` / `LineItemsPanel`) |
| 25 | §38.8 | AI Co-Pilot in quote builder (agent-facing) | ✅ Closed in #350 (`/api/agent/quote-copilot` stateless endpoint + `<QuoteCopilotPanel>` on `(tenant)/crm/quotes/[id]/page.tsx`) |

### Spec sweeps / UX reviews (closed via verification, not build)

| # | § | What | Status |
|---|---|---|---|
| 26 | §10.5 | Supervisor dashboard UX completeness | ✅ Closed in #346 — directive bug fixed (`"use server"` → Server Component) + header comment trimmed to match actual JSX. Core §10.5 dimensions all rendered (kill switch, escalations, flagged by check, regen exhaustion, drift trend, per-persona metrics) |
| 27 | §32.9 | Bug-triage console operator workflow | ✅ Verified — implemented as `.claude/commands/fix-bugs.md` slash command per supplement reclassification. All §32.9.5 safeguards present (issue-content-as-data, scoped fixes, no exfiltration, human-in-the-loop) |
| 28 | §32.16 | §32 "Calls Worth Flagging" audit vs D-067/D-068 | ✅ Verified clean — D-068 follow-up #2 (wire bug-intent recognizer into customer chat handler) confirmed done at `chat/route.ts:62` |
| 29 | §27.13 | Cross-section abuse integrations spot-check | ✅ Verified clean — §22 RAG (rag-pii-redact, rag-normalize, rag-tenant-approval-rate-nightly), §23 email (`send.ts` uses `incrementEmailSent`), §26 monitoring crons emit signals via dedicated path (correct layering — forensic detectors, not quota counters). §13 host-adapter: no quota integration (correct — host calls aren't a BP27 dimension) |

### Backend orphans

| # | § | What | Status |
|---|---|---|---|
| 30 | §27.6 | `lib/abuse/enforcement.ts` orphan | ✅ Closed in #341 (deleted) |

---

## P3 — cost-deferred (operator opt-in path exists; flip when ready)

Each has a stub that returns a known-safe default; enabling requires a config flag flip + the underlying Haiku call to be added. Estimated marginal cost noted.

| # | § | What | Cost when enabled | Source | Notes |
|---|---|---|---|---|---|
| 31 | §32.13.2 | Help screenshot vision-PII detector — stub returns `{ detected: false }` | ~$30/mo @ 10K submissions | delta §1 / D-068 | Operator flips `platform_settings.screenshot_pii_block_mode` |
| 32 | §32.6.5 | Help-AI confidence scoring — stub returns uniform 0.5 | ~$1.50/mo @ 1K submissions | delta §1 / D-066 | Calibration is the bottleneck, not cost — wait for 100+ real submissions |
| 33 | §22.4 | Tolerable-PII Haiku redaction (Stage 2) — pass-through; Stage 1 regex still runs | ~$0.50-1.50/day @ 1K chunks (was ~$1-3 pre-batches) | delta §1 | Highest-impact cost-deferred item per d091 follow-ups. **F12 absorbed:** when Stage 2 wires up, route through §27.12 Anthropic Batches pipeline (PR #363) — ingest is fully async, so it's the canonical use case. Producer: enqueue with `purpose: "rag_pii_redaction"` (already in `BatchablePurpose`). Consumer: handle `ai.batch_request.completed.rag_pii_redaction`. Batches drop the per-token cost ~50% — updated cost estimate reflects that. |
| 34 | §24 | Tone-match Haiku — TODO; heuristic int-1-to-5 match is the baseline today | ~$1.50/mo | delta §1 | Low priority |
| 35 | §12 / §30.6 | AI evaluation harness — design-only; no CI hook, no golden set, no cron | $20-50/run; $100-250/mo @ weekly | delta §1 / D-024 | Designed at `docs/evals/design.md`; productionize after launch with real conversation data |
| 36 | §32.10 | Customer-chat / Help-AI Gmail auto-reply — downstream of Gmail OAuth start (still WAIT-on-operator) | TBD | delta §1 | Cross-ref #47 |

---

## P4 — blocked on external (legal, operator, vendor)

### Legal / attorney sign-off

| # | § | What | Action | Source | Notes |
|---|---|---|---|---|---|
| 37 | §15.14.6 | ICA chunk-license-survival clause text — attorney finalize | WAIT | delta §3 / s1 | Phase-2 launch gate for sub-host onboarding |
| 38 | §16.7.1 | Always-on legal-page attribution wording — attorney finalize | WAIT | delta §3 | Same engagement as #37 |
| 39 | §15.7 | SOT / E&O attorney engagement for 5 states (CA/FL/HI/IA/WA) | WAIT | delta §3 / s1 | Phase-2 sub-host onboarding launch gate |
| 40 | §25.9 | Breach notification email templates — `TODO(legal-counsel)` markers in `emails/BreachNotification{User,TenantAdmin}.tsx` | WAIT | delta §1 §3 / s1 | Templates wired, code-ready; wording blocks send-path activation |
| 41 | §16 / §17 | Counsel sign-off on ICA + AI Liability Disclaimer | WAIT | s1 / SESSION | Bundle with #37/#38/#39 in same engagement |
| 42 | §33.9.1 | Counsel ToS review (cruise-line scraping + CruiseMapper + image hot-linking) | WAIT | s1 | Same legal engagement |
| 43 | §25.5 | Sub-processors disclosure annual review cadence — operator commits to cycle | WAIT | delta §3 / s1 | Operator commits to schedule; small spec note |

### Operator content seeding

| # | § | What | Action | Source | Notes |
|---|---|---|---|---|---|
| 44 | §23.4 / port info | Seed RAG with port chunks for 17 North American departure ports (BP23) | CONTENT | SESSION carried-forward | T-1 day email depends on this |
| 45 | §24.5 | Populate `platform_settings.supervisor_slur_deny_list` (BP24) | CONTENT | SESSION carried-forward | Lexical deny-list maintenance |
| 46 | §13.5 / §28.20 | `PLATFORM_PEPPER` offsite storage + DO-NOT-ROTATE documentation (BP25) | OPERATOR + CONTENT | SESSION carried-forward | One-time setup; runbook update |

### Operator infrastructure provisioning

| # | § | What | Action | Source | Notes |
|---|---|---|---|---|---|
| 47 | §23.9 / §34.2 | Gmail integration: OAuth start flow + callback routes return 501 until operator provisions GCP project | WAIT → BUILD | delta §9 | Pub/Sub webhook + storage + health endpoint live; runbook complete at `docs/runbooks/gmail-inbound-setup.md`. Step 5 build is small once operator provisions |

### Operator decisions

| # | § | What | Decision needed | Source | Notes |
|---|---|---|---|---|---|
| 48 | §13.9 | Host-adapter active health probing — keep reactive-only OR add nightly probe | DECIDE | delta §4 / s1 / D-087 | Operator-confirmed reactive-only 2026-05-26; revisit if signal arrives slowly |
| 49 | §33.12 | Per-line actor coverage for Carnival / Holland America / MSC / Disney | DECIDE | s1 | Currently `enabled: false` with `TBC/<line>` placeholders |
| 50 | §33.12 | UX for uncovered cruise lines (Virgin / Viking / Oceania / Regent / Silversea / Seabourn) | DECIDE | s1 | Quick verification + copy tweak if needed |
| 51 | §33.12 | Authority-override platform-admin UI for elevating/demoting batches of itinerary chunks | DECIDE | s1 | Build, defer, or rule out |
| 52 | §33.9.3 | Apify token scoping — confirm scoped-token shape OR document risk acceptance | DECIDE | s1 | `APIFY_API_TOKEN` is account-level |
| 53 | §33.9.3 | Budget priority for general-pricing vs tracked-sailings refresh | DECIDE → BUILD | s1 | Subscriber watches should pause LAST. Add sub-cap or priority flag |
| 54 | §10.6 | Kill-switch permission model — today any `assertPlatformAdmin` user can flip | DECIDE | s1 | Tighten permission or accept current model |
| 55 | §11.5 | DOB estimation re-prompt cycle is yearly (>365d) | DECIDE | s1 | Could be punishingly slow for a customer with estimated DOB |

---

## P5 — future build prompts (scheduled, blocked on prior phases)

| # | § | What | Status |
|---|---|---|---|
| 56 | §9.6 | Persona tools registry + dispatch | 🟡 PR #358 in flight — 3 real handlers (escalate_to_human, get_customer_context, update_memory) + 3 honest placeholders (search_host_inventory, generate_quote, collect_booking_details) returning structured `not_implemented` + `can_fall_back_to: escalate_to_human`. Wired into `/api/chat` non-streaming branch. Follow-ups: streaming-mode wire-in, `contact_id` threading, `ai_tool_calls` audit table, real implementations for the 3 placeholders (each gated on its owning BP). See [[D-105]]. |
| 57 | §17.4 | Legal documents render from `legal_documents` table — `TODO(prompt-17)` | open — small DB-lookup swap once prioritized |
| 58 | §20.2 | Platform-native fallback booking flow customer UI — `TODO(prompt-24)` | 🟡 PR #359 (partial) — Stage 1 (Trip Details) wired end-to-end (prefetch from `GET /api/bookings/[id]`, save via PATCH, advance). Confirmation landing page built at `/booking/confirmation/[id]` (was Stage 4's redirect target; pre-PR it 404'd). Stages 2 (passengers) + 3 (options) deferred — need `booking_passengers` CRUD endpoint + addons table. |
| 59 | §27.4 / §27.12 | Cost-display surfaces in tenant `/settings/ai-mode` | ✅ Closed in #355 — new `GET /api/tenant/ai-config/cost-projection` reads `tenant_usage_metrics.ai_cost_cents` + linear-extrapolates month-end. Page shows MTD + projection. All 4 `TODO(§27.12-cost-display)` markers removed. |

---

## P6 — runbooks / docs to write (small, non-blocking)

| # | What | Action | Source | Notes |
|---|---|---|---|---|
| 60 | `docs/runbooks/supabase-setup.md` for production Supabase project provisioning | BUILD-doc | s1 | New environments + ops handoff need this |
| 61 | `docs/runbooks/pentest-scoping.md` before scheduling first annual engagement (§26.11) | BUILD-doc | s1 | Operator scoping aid |
| 62 | Verify `docs/local-development.md` matches `apps/main/.env.example` after BP29 + BP31 env reconciliation | DECIDE-doc | s1 / D-101 | D-101 already updated local-dev for GitHub App vars |

---

## Follow-up gaps surfaced by this session's work

These weren't in the original punch list — they're new gaps created or made-visible while closing the original items.

| # | What | Status |
|---|---|---|
| F1 | Wire §10 supervisor through `/api/public/chat/[token]` (token-gated customer chat) | 🟡 PR #357 in flight. Adds `conversations.public_access_token_hash` column + `public_token_chat` TenantContext kind + full regen loop. SHA-256-hashes the URL token (never stores raw); one stable conversation per (tenant, token). See [[D-104]]. |
| F2 | Tenant-facing booking list page `(tenant)/crm/bookings/page.tsx` | ✅ Closed in #354 — list with status filter, customer-name search, status pills, pagination. Backed by new `GET /api/bookings` (paginated + filterable). |
| F3 | Booking PATCH endpoint integration with state-machine transitions | ✅ Closed in #354 — `PATCHABLE_FIELDS_BY_STATUS` allowlist: draft + pending_host_review can edit trip details; submitting/submitted/confirmed/cancelled/failed reject with 409 + friendly explanation pointing at modify flow. Platform-only fields (host_*, ai_paused_by_platform, is_test, status) never editable. 6 unit tests. |

## New follow-ups from this overnight session

| # | What | Notes |
|---|---|---|
| F4 | Streaming-mode tool support in `/api/chat` | Non-streaming branch wires `PERSONA_TOOLS`; streaming branch unchanged. Material work — `tool_use` blocks during streaming require delta buffering + partial-block reassembly. Tenants with `CHAT_STREAMING_ENABLED=true` currently don't see tool calls. |
| F5 | `contact_id` threading through chat tool dispatch | Hardcoded to `null` in #358. Small touch to pull `conversations.contact_id` into the dispatch context so `get_customer_context` and `update_memory` work. |
| F6 | `ai_tool_calls` audit table | Tonight's logging is `console.info`. A queryable history of tool dispatches would help post-hoc cost / abuse analysis. |
| F7 | Real `search_host_inventory` handler | Placeholder today. Needs host-adapter search API standardization across adapter types (BP14 scope). |
| F8 | Booking flow Stages 2/3 wiring | #359 ships Stage 1 + confirmation page. Stage 2 (passenger details) needs a `booking_passengers` CRUD endpoint; Stage 3 (options) needs an addons table + endpoint. |
| F9 | Dependabot PRs #329/#330 | Both have real CI failures (Lint, Typecheck, Build, Test fail — not just Vercel waivers). Version bumps must be breaking something. Need human investigation before merge. |

---

## Tracking-doc accuracy fixes (not in punch list, but worth noting)

These don't need engineering work — they're updates to the audit-followups doc / d091 addendum to reflect reality:

- **Round-3 #43 chat kill switch in streaming** — verified FIXED at `apps/main/src/app/api/chat/route.ts:543-565`. The d091 addendum (2026-05-27) still says "pending." Update addendum §3 §10.6 footnote and pattern catalog §6 item 14.
- **Round-3 #47 quote price-lock expiry** — verified FIXED at `quotes/[id]/accept/route.ts:83-89`. Update audit-followups doc and addendum's "Recommended Tier-1 additions" list.
- **`reality-delta-supplement.md` §19.10 entry** is a spec misread (per reality-delta.md §12). Annotate the supplement entry as "not actually a gap — see delta §12."

---

## Effort summary (remaining)

| Bucket | Open count | Notes |
|---|---|---|
| **P1 launch-blocking** | 0 | ✅ All closed |
| **P2 spec-promised gaps** | 0 build items | ✅ All closed |
| **P3 cost-deferred** | 6 items | ~$30-280/month operating cost when all enabled — small eng work |
| **P4 external-blocked** | 19 items | Calendar-bound on attorney + operator availability |
| **P5 future build prompts** | #57 fully open · #56 #58 partials in flight (#358 #359) · #59 ✅ | |
| **P6 docs** | 3 items | <1 day total |
| **F1/F2/F3 follow-ups** | F1 🟡 in flight (#357), F2 ✅, F3 ✅ | |
| **F4–F9 new follow-ups** | 6 items | F4 streaming-mode tools, F5 contact_id threading, F6 ai_tool_calls audit, F7 real host inventory, F8 booking flow Stages 2/3, F9 dependabot CI fails |

**Highest-priority remaining engineering work (reconciled 2026-05-29 — see issues #421–#430):**
1. **#421 / F4** Streaming-mode tool support — completes #56's wire-in (unblocked)
2. **#422 / #57** Legal docs from table + `legal_consents` writes (unblocked; attorney wording is a separate content gate)
3. **#424 / F8** Booking flow Stages 2/3 — needs `booking_passengers` + add-ons tables
4. **#429 / #47** Gmail Step-5 build (waits on operator GCP provisioning)
5. **#426 / P3 #33** Tolerable-PII Stage-2 Haiku ($1-3/day; batch path already landed #368)

(F9 is resolved — dependabot #329/#330 are both closed.)
