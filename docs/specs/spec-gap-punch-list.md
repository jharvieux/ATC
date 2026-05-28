# Spec gap punch list

Working list of open gaps from `reality-delta.md`, `reality-delta-supplement.md`, and `reality-delta-supplement-2.md`. Items here are things to **close** (build, decide, or wait on) — not spec-text edits (those live in `reality-delta.md` and get applied in a future spec-sync pass).

**As of 2026-05-27.**

---

## Conventions

| Column | Meaning |
|---|---|
| `§` | Spec subsection ref |
| **Action** | `BUILD` (engineer it) · `DECIDE` (operator picks one of the listed options) · `WAIT` (blocked on external party) · `FIX` (audit follow-up bug) · `CONTENT` (non-engineering content work) |
| **Effort** | S = under 1 day · M = 1-3 days · L = 4-10 days · XL = multi-week |
| **Source** | `delta` = original reality-delta.md · `s1` = supplement · `s2` = supplement-2 (new) |
| **Status** | `open` · `partially-closed` · `blocked-on-X` |

When an item is closed, mark `> **Closed YYYY-MM-DD in #PR**` next to it.

---

## P1 — close before launch (customer / money / compliance impact)

### Real-money / data-integrity

| # | § | What | Action | Effort | Source | Notes |
|---|---|---|---|---|---|---|
| 1 | §15.12 | Sandbox mode only pauses Stripe; `is_sandbox` never read elsewhere. Tenant flipping sandbox=true still creates real bookings + commissions | DECIDE → BUILD | M | s2 | Decide: wire `is_sandbox` through chat/bookings/commissions to suppress real ops, OR rename feature to "billing pause" and update spec |
| 2 | §18.5 | First-use token TOCTOU (Greptile P1 #54). Concurrent first-uses race; legitimate caller can be locked out | FIX | S | s2 / audit-followups | Add `.eq("token_first_used_at", null)` CAS guard via `safeAwaitRowCount`. Verified still open in code 2026-05-27 |
| 3 | RAG JWT | All `kid` values map to same PEM (Greptile P1 #7). Zero-downtime JWT key rotation is impossible | FIX | M | audit-followups | `apps/rag/src/lib/auth/verify-service-jwt.ts:55-63` — needs kid→PEM map env var |
| 4 | §25.4a | CCPA purge: `conversations.user_id` never nulled (Greptile P2 #13). Contacts.notes IS nulled — this is the remaining piece | FIX | S | s2 / audit-followups | Add `UPDATE conversations SET user_id = NULL` after the contacts-notes nulling step in `purge-user-data.ts` |
| 5 | §17.5 | Email blast on legal-doc version update missing. Users only see new ToU via the consent gate on next sign-in | BUILD | S | s2 | Add Inngest job dispatched on `/api/admin/legal-docs` publish |

### Customer-facing UX

| # | § | What | Action | Effort | Source | Notes |
|---|---|---|---|---|---|---|
| 6 | §11.3 | Customer `/settings/memory` page doesn't exist. Only in-chat sidebar Memory tab (D-097) | BUILD | M | s2 | Standalone customer settings route; reuses existing `/api/memory` |
| 7 | §25.3 | Customer `/settings/profile` page doesn't exist (right-to-correct claimed in policy) | BUILD | M | s2 | Sister page to #6; same auth surface |
| 8 | §11.6 | `/settings/conversations` page doesn't exist — needed to mount `UndoBanner` for 24h soft-commit window | BUILD | M | delta §9 | Component already exists; page is the missing piece |
| 9 | §18.10 | Group "sailed" read-only mode not enforced — group details / RSVP / members editable after travel_start_date | BUILD | S | s2 | Add `sailed_at` / `status='sailed'` check to groups/[id] PATCH + groups/[id]/members POST |
| 10 | §20.5 | DOB confirmation gate — server-side enforcement missing | BUILD | S-M | s1 | `bookings/[id]/submit/route.ts` doesn't check `dob_confirmed_at` on passengers; add column + gate |

### Security / compliance

| # | § | What | Action | Effort | Source | Notes |
|---|---|---|---|---|---|---|
| 11 | §34.3.1 | Document virus scanning not implemented (Gmail attachments + manual upload reach operator unscanned) | DECIDE → BUILD | M-L | s2 | Vercel doesn't support sidecars; needs Fly.io ClamAV or Supabase native scan OR documented risk acceptance |
| 12 | §32.3 | 10 of 12 help docs missing. Blocks BP31 Phase C PDF/Word export from being useful at launch | CONTENT | L | s1 | Not engineering; content authoring workstream |

---

## P2 — spec promises not implemented (lower urgency than P1)

### Easy wins (small effort, real value)

| # | § | What | Action | Effort | Source | Notes |
|---|---|---|---|---|---|---|
| 13 | §9.3 | Anthropic prompt caching declared (env var `ANTHROPIC_PROMPT_CACHE_ENABLED=true`) but unwired. No `cache_control` markers anywhere | BUILD | S | s2 | 30-50% input-token cost reduction on multi-turn chats. Real $ on the table — easy ROI |
| 14 | §24.7 | Chat draft autosave not implemented. Closing tab loses in-progress text | BUILD | S | s2 | localStorage-backed is fine; no server roundtrip needed |
| 15 | §10.6 | Per-tenant kill switch missing (only global exists). Spec says "globally or per-tenant" | BUILD | S | s2 | Add `platform_tenant_overrides.ai_paused_by_platform` column + admin UI surface; chat route already reads platform_settings, mirror for tenant |

### Decision-required (spec edit vs build)

| # | § | What | Action | Effort | Source | Notes |
|---|---|---|---|---|---|---|
| 16 | §4 / §16.4 | "Custom email-from domain" UI captures `email_from_domain` but value is never read. No Resend domain creation/verification | DECIDE | M (if BUILD) | s2 | Decide: wire domain verification + Resend domain creation OR strike the feature from §4 matrix and rename to "email-from address" only |
| 17 | §4 / §1.5 | Feature matrix "Downline (sub-hosts) Y unlimited" contradicts §1.5 forbidden tenant nesting. Zero downline code | DECIDE | S | s2 | Likely a spec-text bug — matrix row probably meant "subcontractor tracking" (§3.4a). Strike row OR rename per delta §12 |
| 18 | §7.9 / §9.9 | SSE `Last-Event-ID` reconnect — header never read | DECIDE | S (spec edit) / L (build) | s2 | Likely spec text overspec — actual application-level resumption is hard for LLM streams. Recommend dropping from spec |
| 19 | §7.9 | `Idempotency-Key` HTTP header not implemented for client mutations | DECIDE | S (spec edit) / M (build) | s2 | If building: need `request_idempotency` table + 24h cleanup cron. Bookings already have CAS guards (#51) so retry-safety exists differently |

### Customer-facing AI panels (bundled build)

| # | § | What | Action | Effort | Source | Notes |
|---|---|---|---|---|---|---|
| 20 | §20.4 / §38.8 / §38.8.1 / §39.5 | Customer-facing AI chat panels for booking flow, quote builder, customer quote view, trip itinerary | BUILD | L | s1 | Dedicated build prompt; needs token-bound auth + context payload to system prompt + supervisor preflight. ~2 days work + browser testing |

### Tenant admin UI gaps

| # | § | What | Action | Effort | Source | Notes |
|---|---|---|---|---|---|---|
| 21 | §16 | Tenant branding UI (logo, colors, custom domain) — API exists, page missing | BUILD | M | s1 | `(tenant)/settings/branding/page.tsx` — partially exists per supplement-2 grep (captures email_from fields) — verify completeness |
| 22 | §16.5 / §9 | Tenant persona overrides + addendum UI — API + screening cron exist; UI missing | BUILD | M | s1 | `(tenant)/settings/personas/page.tsx` |
| 23 | §22.5 | Tenant RAG submission review queue UI — API exists; tenant UI is what's missing (admin-side review queue exists) | BUILD | M | s1 | Note: supplement said this was closed in PR #205, but supplement-2 didn't re-verify. Spot-check before building |

### Editor / co-pilot UI wiring (depends on booking-detail page)

| # | § | What | Action | Effort | Source | Notes |
|---|---|---|---|---|---|---|
| 24 | §39.7 / §40.5 | Itinerary editor, resources editor, line items panel — components exist but `(tenant)/crm/bookings/[id]/page.tsx` doesn't exist to mount them on | BUILD | M | delta §9 | Build booking-detail page first; then mount three editor panels |
| 25 | §38.8 | AI Co-Pilot in quote builder (per-option suggestions) | BUILD | M | s1 | Separate from #20 customer-facing AI panels — this is the tenant-agent-facing co-pilot |

### Spec sweeps / UX reviews (research, not engineering)

| # | § | What | Action | Effort | Source | Notes |
|---|---|---|---|---|---|---|
| 26 | §10.5 | Supervisor dashboard — UX review against spec for completeness (244-line page exists) | DECIDE → BUILD | S (review) + variable | s1 | Confirm all dimensions render (sample category counts, regen budget, kill-switch, drift chart) |
| 27 | §32.9 | Interactive bug triage console — UX review against spec | DECIDE | S | s1 | Reclassified to slash-command path per supplement; verify operator workflow matches §32.9 |
| 28 | §32.16 | Sweep §32 "Calls Worth Flagging" items against MEMORY D-067/D-068 for completeness | DECIDE | S | s1 | Doc audit; surfaces follow-up gaps if any |
| 29 | §27.13 | Cross-section abuse integrations spot-check (§13 / §22 / §23 / §26) | DECIDE | S | s1 | Per-integration verification; most are wired |

### Backend orphans (wire-in or remove)

| # | § | What | Action | Effort | Source | Notes |
|---|---|---|---|---|---|---|
| 30 | §27.6 | `lib/abuse/enforcement.ts` — exists with structural scaffolding but no callers. Knip flagged as unused | DECIDE | S | delta §9 | Wire it in OR delete |

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
| 36 | §32.10 | Customer-chat / Help-AI Gmail auto-reply — downstream of Gmail OAuth start (still WAIT-on-operator) | TBD | delta §1 | Cross-ref #46 below |

---

## P4 — blocked on external (legal, operator, vendor)

### Legal / attorney sign-off

| # | § | What | Action | Source | Notes |
|---|---|---|---|---|---|
| 37 | §15.14.6 | ICA chunk-license-survival clause text — attorney finalize | WAIT | delta §3 / s1 | Phase-2 launch gate for sub-host onboarding |
| 38 | §16.7.1 | Always-on legal-page attribution wording — attorney finalize | WAIT | delta §3 | Same engagement as #37 |
| 39 | §15.7 | SOT / E&O attorney engagement for 5 states (CA/FL/HI/IA/WA) | WAIT | delta §3 / s1 | Phase-2 sub-host onboarding launch gate |
| 40 | §25.9 | Breach notification email templates — `TODO(legal-counsel)` markers in `emails/BreachNotification{User,TenantAdmin}.tsx` | WAIT | delta §1 §3 / s1 | Templates wired, code-ready; wording blocks send-path activation |
| 41 | §16 / §17 | Counsel sign-off on ICA + AI Liability Disclaimer (SESSION.md carried-forward BP16/17) | WAIT | s1 / SESSION | Bundle with #37/#38/#39 in same engagement |
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
| 48 | §13.9 | Host-adapter active health probing — keep reactive-only (current, cheaper) OR add nightly probe | DECIDE | delta §4 / s1 / D-087 | Operator-confirmed reactive-only 2026-05-26; this is to revisit if signal arrives slowly |
| 49 | §33.12 | Per-line actor coverage for Carnival / Holland America / MSC / Disney — commission Apify actors OR block price-watch for those lines | DECIDE | s1 | Currently `enabled: false` with `TBC/<line>` placeholders; UI blocks creation |
| 50 | §33.12 | UX for uncovered cruise lines (Virgin / Viking / Oceania / Regent / Silversea / Seabourn) — verify "no price-watch available" copy renders explicitly | DECIDE | s1 | Quick verification + copy tweak if needed |
| 51 | §33.12 | Authority-override platform-admin UI for elevating/demoting batches of itinerary chunks | DECIDE | s1 | Build, defer, or rule out — operator owes a decision |
| 52 | §33.9.3 | Apify token scoping — confirm whether Apify offers a scoped-token shape; use it or document risk acceptance | DECIDE | s1 | `APIFY_API_TOKEN` is account-level — platform caps don't constrain the raw token |
| 53 | §33.9.3 | Budget priority for general-pricing vs tracked-sailings refresh — currently no priority order; both share same monthly cap | DECIDE → BUILD | s1 | Spec wants subscriber watches (tracked-sailings) to pause LAST. Add sub-cap or priority flag |
| 54 | §10.6 | Kill-switch permission model — today: any `assertPlatformAdmin` user can flip. Spec doesn't explicitly scope further | DECIDE | s1 | Tighten permission or accept current model |
| 55 | §11.5 | DOB estimation re-prompt cycle is yearly (>365d). Operator confirm intended cadence | DECIDE | s1 | Could be punishingly slow for a customer who provided an estimated DOB |

---

## P5 — future build prompts (scheduled, blocked on prior phases)

| # | § | What | Source | Notes |
|---|---|---|---|---|
| 56 | §9.6 | Persona tools registry (real schemas) — `TODO(prompt-12/13/14)` | delta §2 | Tool dispatch works; schemas are placeholder shapes |
| 57 | §17.4 | Legal documents render from `legal_documents` table — `TODO(prompt-17)` | delta §2 | Schema + publish flow + consent gate work; onboarding render still uses inline placeholders |
| 58 | §20.2 | Platform-native fallback booking flow customer UI — `TODO(prompt-24)` | delta §2 / s1 | Booking ENGINE built (adapters, commissions, payouts); customer-facing flow is what's missing |
| 59 | §27.4 / §27.12 | Cost-display surfaces in tenant `/settings/ai-mode` — `TODO(§27.12-cost-display)` | delta §2 | Hardcoded "varies based on usage" today; wire once `tenant_usage_metrics` aggregation lands |

---

## P6 — runbooks / docs to write (small, non-blocking)

| # | What | Action | Source | Notes |
|---|---|---|---|---|
| 60 | `docs/runbooks/supabase-setup.md` for production Supabase project provisioning | BUILD-doc | s1 | New environments + ops handoff need this |
| 61 | `docs/runbooks/pentest-scoping.md` before scheduling first annual engagement (§26.11) | BUILD-doc | s1 | Operator scoping aid |
| 62 | Verify `docs/local-development.md` matches `apps/main/.env.example` after BP29 + BP31 env reconciliation | DECIDE-doc | s1 / D-101 | Quick audit; D-101 already updated local-dev for GitHub App vars |

---

## Tracking-doc accuracy fixes (not in punch list, but worth noting)

These don't need engineering work — they're updates to the audit-followups doc / d091 addendum to reflect reality:

- **Round-3 #43 chat kill switch in streaming** — verified FIXED at `apps/main/src/app/api/chat/route.ts:543-565`. The d091 addendum (2026-05-27) still says "pending." Update addendum §3 §10.6 footnote and pattern catalog §6 item 14.
- **Round-3 #47 quote price-lock expiry** — verified FIXED at `quotes/[id]/accept/route.ts:83-89`. Update audit-followups doc and addendum's "Recommended Tier-1 additions" list.
- **`reality-delta-supplement.md` §19.10 entry** is a spec misread (per reality-delta.md §12). Annotate the supplement entry as "not actually a gap — see delta §12."

---

## Effort summary (rough total)

If a small team picked through this top-to-bottom:

| Bucket | Count | Total effort |
|---|---|---|
| P1 launch-blocking | 12 items | ~3-5 weeks of engineering + 1 content workstream (10 help docs) |
| P2 spec-promised gaps | 18 items | ~4-6 weeks if all built (some are DECIDE-then-spec-edit, cheaper) |
| P3 cost-deferred | 6 items | ~$30-280/month operating cost when all enabled — engineering is small (mostly removing the stub) |
| P4 external-blocked | 19 items | Calendar-bound on attorney + operator availability; engineering work is small once unblocked |
| P5 future build prompts | 4 items | Scheduled work; each is its own BP |
| P6 docs | 3 items | <1 day total |

**Highest-ROI early targets:**

- **#13 Anthropic prompt caching** — small effort, real $ saved.
- **#2 First-use TOCTOU fix** — small, closes a P1 audit finding.
- **#4 conversations.user_id CCPA nulling** — small, closes a P2 audit finding.
- **#5 legal-doc email blast** — small, closes a customer-trust gap.
- **#9 group sailed read-only** — small, closes a data-integrity gap.
- **#1 Sandbox mode decision** — small DECIDE, then either spec-text edit (no code) or moderate BUILD.

That cluster (~1 week of engineering) closes 6 items and the highest-impact P1s.
