# Session state — last updated 2026-05-28 ~15:00 UTC

## Just completed

Cost-optimization sweep + persona-tool hardening + dependabot triage.

### PRs merged this session
- **#362** vendor-health probe — drop Anthropic from GET probe (1,440 wasted req/day → 0)
- **#363** Anthropic Message Batches infra + pre-cruise migration + T-1/multiphase scheduler split
- **#364** reality-delta appendix for PRs #354-363, F12 absorbed into P3 #33
- **#365** F10 + F11 — extract-memory + persona-addendum-screen batches
- **#367** F11 sibling — persona-addendum-rescreen-nightly batches
- **#369** §9.6 ai_tool_calls audit table + dispatcher wire-in

### PRs in flight
- **#366** session+memory updates (this PR)
- **#368** F12 — RAG Stage 2 PII redaction batches (conflict resolved + pushed)
- **#370** §9.6 — thread contact_id from conversation row into tool dispatch
- **#371** §9.6 — streaming-mode tool support in /api/chat (stacked on #370)

### Dependabot investigation results
- **#329** (production-minor-patch, 8 bumps): pnpm minimumReleaseAge policy rejecting `stripe@22.2.0` (published <24h before CI run). No code issue — passes after ~21:00 UTC today.
- **#330** (dev-dependencies, includes vite 7→8): vite 8 breaks JSX/TSX transform in 3 test files at vitest load time. Vitest 4.1.7 declares vite 8 peer support but real-world incompatibility. Recommend adding a Dependabot ignore for vite major bumps until vitest publishes a confirmed-compatible release.

### Decisions logged this session
- **D-106** Anthropic Message Batches for backgroundable Haiku surfaces (~50% token discount + separate rate-limit pool)
- **D-107** Pre-cruise scheduler split — hourly T-1 (direct, ±1h) + daily T-7/30/90 (batched, ±12h)

## In flight

Background merge loops running for #368 (F12), #370 (contact_id), #371 (streaming), #366 (this PR).

`feature/f12-rag-stage2-batches` was DIRTY → resolved (merge from dev; trivial conflicts in event-registry / ai-batch-flush / api/inngest/route — all "keep both"). Pushed.

## Next step

1. Wait for #366 / #368 / #370 / #371 / #362 to merge in some order.
2. **#329 retrigger**: rebase + push after 2026-05-28T20:26Z (or close + let Dependabot re-open next cycle).
3. **#330 follow-up**: add vite-major ignore rule to `.github/dependabot.yml`, then close #330.

## Blocked on user

- **#329 / #330 action** — decision on the dependabot follow-up steps above.
- **Streaming tool support browser test** — #371 needs a manual smoke test (open streaming chat, ask a context question, watch for `rewriting` event followed by tool-driven response).
- **Booking flow Stages 2/3** — same as prior session.

## Open questions

- **Streaming tool follow-up call cost**: PR #371 makes a SECOND streaming Anthropic call when tools fire. Today's first stream paid for any pre-tool prose tokens, which the follow-up effectively wastes. Acceptable for now (matches industry-standard tool-use billing) but worth a note if streaming + tools is high-volume.
- **`ai_tool_calls` retention**: no cron yet purges old rows. Per §26.5 audit retention is 7 years; if `ai_tool_calls` should follow the same purge cron, that's a small wire-up follow-up.
- **persona-addendum-rescreen-nightly cron**: hourly flush 04:30 → 12:30 UTC drains the daily burst. If approved-addendum count grows past a few hundred per tenant, may need extending to 18:30 UTC or wider.

## Carried forward (unchanged from prior session)

- BP39 follow-up: retroactive react-pdf wire-up
- BP31: Haiku tolerable-PII redaction confidence/clarity scorer (cost-deferred — punch list P3 #32)
- BP30: AI behavior eval harness (cost-deferred — punch list P3 #35)
- BP25: PLATFORM_PEPPER offsite storage + DO-NOT-ROTATE doc (punch list P4 #46)
- BP24: populate `platform_settings.supervisor_slur_deny_list` (punch list P4 #45)
- BP23: populate `port_info_chunks` content for 17 ports (punch list P4 #44)
- BP16/17: counsel sign-off on ICA + AI Liability Disclaimer (punch list P4 #41)
- §13.9 active vs reactive health probing — operator decision (punch list P4 #48)
- `contact_id` threading in chat tool dispatch → ✅ #370
- Streaming-mode tool support in `/api/chat` → ✅ #371
- `ai_tool_calls` audit table → ✅ #369
- Booking flow Stages 2/3 (passenger details + options)
