# Session state — last updated 2026-05-28 ~14:00 UTC

## Just completed

Cost-optimization sweep triggered by Anthropic Haiku rate-limit alert. Root caused, migrated three Haiku surfaces to the Message Batches API (§27.12), split the pre-cruise scheduler into hourly T-1 and daily T-7/30/90 lanes, and updated specs.

### PRs merged this session
- **#362** vendor-health probe fix — drop Anthropic from probe (`/v1/messages` is POST-only; GET returned 405 every minute = 1,440 wasted requests/day → 0). Real Anthropic calls already record vendor health via the call-wrapper.
- **#363** AI batches infrastructure + pre-cruise migration
  - `ai_batch_requests` + `ai_batch_jobs` tables (service-role RLS), migration `20260528000000_ai_batches.sql`
  - call-wrapper: `submitAnthropicBatch` / `getAnthropicBatchStatus` / `getAnthropicBatchResults`, `logAndIncrement` exported
  - `lib/ai/batch/`: `types.ts` (BatchablePurpose), `enqueue.ts`, `flush.ts`, `reconcile.ts`
  - `ai-batch-reconcile.ts` cron (every 5 min, concurrency 1)
  - `ai-batch-flush-precruise` daily 9:30 UTC; `ai-batch-flush-memory-extraction` hourly
  - Pre-cruise scheduler split: `preCruiseEmailSchedulerT1` (hourly, direct, T-1 only, ±1h precision) + `preCruiseEmailSchedulerMultiphase` (daily 9:00 UTC, batched, T-7/30/90, ±12h)
  - Pre-cruise consumer dual-path by `event.data.via`: direct (legacy 4-5 calls) or batched (one structured-JSON prompt, then `precruiseSendFromBatchResult`)
- **#364** reality-delta appendix for PRs #354–#363; F12 absorbed into P3 #33 (RAG Stage 2 redaction goes through batch pipeline when wired)

### PRs in flight
- **#365** F10 + F11 — extract-memory + persona-addendum-screen migrated to batches. Open, mergeable, waiting on CI checks. Background merge loop `/tmp/atc-merge-364-365.sh` is polling and will squash-merge once checks pass.

### F10 / F11 details (in #365)
- **F10 extract-memory** — producer enqueues with `caller_metadata: { tenant_id, conversation_id, user_id }`; new consumer `extractMemoryFromBatchResult` re-loads memory row for fresh optimistic-lock state, parses + Zod-validates, merges, writes with optimistic lock; conflict requeues via `conversation.memory_extract_requested`. `applyExtractedMemory` exported. 6 new consumer unit tests + integration mocks updated.
- **F11 persona-addendum-screen** — producer enqueues with `caller_metadata: { tenant_id, addendum_id }`; new consumer `personaAddendumScreenFromBatchResult` parses fail-closed (parse errors → rejected), updates row, emails owners on reject, audit-logs. `parseScreenResult` exported. 6 new parse unit tests. `aiBatchFlushPersonaAddendumScreen` cron added (every 30 min).
- Lint allowlist: `/inngest/extract-memory.ts` added with §27.12 rationale (`ai_batch_requests` is service-role-only RLS).

### Decisions logged this session
- **D-106** Migrate to Anthropic Message Batches API for backgroundable Haiku surfaces (~50% token discount + separate rate-limit pool that doesn't compete with real-time chat). Scope: precruise generation, memory extraction, persona-addendum screen. Real-time chat stays direct.
- **D-107** Split pre-cruise email scheduler into hourly T-1 (direct, ±1h precision) and daily T-7/30/90 (batched, ±12h precision). T-1 customer expectation is "tomorrow!" at the right hour; T-90/30/7 are fine with daily granularity.

## In flight

Background merge loop `/tmp/atc-merge-364-365.sh` PID 30316 watching #365. Will squash-merge once required checks turn green. Estimated 5-15 min depending on CI.

## Next step

1. Wait for #365 to merge. If checks fail, read the failure output and fix in-PR.
2. Optional follow-up: migrate `persona-addendum-rescreen-nightly.ts` to batches (similar pattern; deferred because volume is bounded by cron rate, not tenant edits).
3. Optional follow-up: wire F12 (RAG Stage 2 tolerable-PII redaction through batch pipeline) when P3 #33 comes off the punch list.

## Blocked on user

- **Dependabot #329 / #330** still failing CI — unchanged from prior session.
- **Streaming tool-use support** in `/api/chat` — unchanged from prior session.

## Open questions

- **persona-addendum-rescreen-nightly** — migrate now or defer? Low-volume so less urgent, but the same direct-call surface still exists.
- **batch metrics** — should the reconciler expose per-purpose latency + cost-per-row in `tenant_usage_metrics`? Today it attributes raw cost via `logAndIncrement`; per-purpose roll-up would need a new metric key.

## Carried forward (unchanged from prior session)

- BP39 follow-up: retroactive react-pdf wire-up
- BP31: Haiku tolerable-PII redaction confidence/clarity scorer (cost-deferred — punch list P3 #32, also now F12 in P3 #33 batched-path)
- BP30: AI behavior eval harness (cost-deferred — punch list P3 #35)
- BP25: PLATFORM_PEPPER offsite storage + DO-NOT-ROTATE doc (punch list P4 #46)
- BP24: populate `platform_settings.supervisor_slur_deny_list` (punch list P4 #45)
- BP23: populate `port_info_chunks` content for 17 ports (punch list P4 #44)
- BP16/17: counsel sign-off on ICA + AI Liability Disclaimer (punch list P4 #41)
- §13.9 active vs reactive health probing — operator decision (punch list P4 #48)
- Streaming-mode tool support in `/api/chat`
- `contact_id` threading in chat tool dispatch
- Booking flow Stages 2/3 (passenger details + options)
- `ai_tool_calls` audit table
