# Spec gap punch list

Working list of open gaps from `reality-delta.md`, `reality-delta-supplement.md`, and `reality-delta-supplement-2.md`. Items here are things to **close** (build, decide, or wait on) — not spec-text edits (those live in `reality-delta.md` and get applied in a future spec-sync pass).

**As of 2026-05-27 (post-P1/P2 close-out).**

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
| 33 | §22.4 | Tolerable-PII Haiku redaction (Stage 2) — pass-through; Stage 1 regex still runs | ~$1-3/day @ 1K chunks | delta §1 | Highest-impact cost-deferred item per d091 follow-ups |
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

| # | § | What | Source | Notes |
|---|---|---|---|---|
| 56 | §9.6 | Persona tools registry (real schemas) — `TODO(prompt-12/13/14)` | delta §2 | Tool dispatch works; schemas are placeholder shapes |
| 57 | §17.4 | Legal documents render from `legal_documents` table — `TODO(prompt-17)` | delta §2 | Schema + publish flow + consent gate work; onboarding render still uses inline placeholders |
| 58 | §20.2 | Platform-native fallback booking flow customer UI — `TODO(prompt-24)` | delta §2 / s1 | Booking ENGINE built (adapters, commissions, payouts); customer-facing flow is what's missing |
| 59 | §27.4 / §27.12 | Cost-display surfaces in tenant `/settings/ai-mode` | delta §2 | Hardcoded "varies based on usage" today; wire once `tenant_usage_metrics` aggregation lands |

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

| # | What | Source | Notes |
|---|---|---|---|
| F1 | Wire §10 supervisor through `/api/public/chat/[token]` (token-gated customer chat) | D-102 / PR #351 | The endpoint ships without supervisor; mitigated by strong system-prompt ground rules + read-only surface. Wiring requires ephemeral conversations table or `public_token` identity in conversations + writeback shape for supervisor findings against the token's resource. Multi-day effort. |
| F2 | Tenant-facing booking list page `(tenant)/crm/bookings/page.tsx` | PR #349 | Detail page exists now; list page doesn't. Same gap as quotes had. Small effort. |
| F3 | Booking PATCH endpoint integration with state-machine transitions | PR #349 | PATCH currently allows direct edits of cruise/ship/cabin fields; doesn't enforce status-machine constraints (e.g., editing cabin on a submitted booking). Acceptable for draft-state edits; tighten for non-draft. |

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
| **P1 launch-blocking** | 0 | ✅ All closed this session |
| **P2 spec-promised gaps** | 0 build items remaining | ✅ All closed or queued in merge chain |
| **P3 cost-deferred** | 6 items | ~$30-280/month operating cost when all enabled — small eng work (mostly removing the stub) |
| **P4 external-blocked** | 19 items | Calendar-bound on attorney + operator availability |
| **P5 future build prompts** | 4 items | Each is its own scheduled BP |
| **P6 docs** | 3 items | <1 day total |
| **Follow-ups from this session** | 3 items | F1 is the most significant (supervisor on token chat) |

**Highest-priority remaining engineering work:**
1. **F1** Wire supervisor on token-gated chat — closes a real customer-AI safety gap
2. **#47** Gmail Step-5 build (waits on operator GCP)
3. **P3 #33** Tolerable-PII Stage 2 ($1-3/day; the most-used cost-deferred surface)
