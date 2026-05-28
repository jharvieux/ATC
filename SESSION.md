# Session state — last updated 2026-05-27 ~22:00 UTC

## Just completed

Closed the full P1 + P2 punch list. ~22 PRs in flight or merged this session. Punch list condensed from 62 items to a residual P3-P6 (cost-deferred / blocked-on-external / future BPs).

### PRs merged this session
- **#331** sandbox-mode wiring (`is_sandbox` short-circuit through chat/bookings/commissions) + spec-gap docs
- **#332** invite first-use TOCTOU fix (`safeAwaitRowCount` CAS guard)
- **#333** RAG JWT kid→PEM mapping for zero-downtime rotation
- **#334** CCPA purge nulls `conversations.user_id`
- **#335** groups sailed read-only enforcement (`assertGroupNotSailed` helper)
- **#336** virus-scan risk-acceptance runbook
- **#337** customer settings pages (/memory, /profile, /conversations) + permission grants
- **#338** Anthropic prompt caching wired via `buildSystemArg`
- **#339** help-AI chat draft autosave
- **#341** delete unwired `lib/abuse/enforcement.ts`
- **#343** email-from domain verification API + send.ts uses verified domain
- **#345** help docs (01 getting-started, 12 troubleshooting, settings-ai-mode)
- **#346** branding email-domain verify card + supervisor `"use server"` directive fix
- **#347** customer AI panel on booking flow (P2 #20 phase 1) — server-resolved context + `<CustomerContextChatPanel>`
- **#348** slop-check `execFileSync` so Next.js `(admin)` route-group paths don't break the shell
- **#349** booking-detail page mounts itinerary + resources + line-items editors (P2 #24)
- **#350** quote-builder AI co-pilot panel (P2 #25)

### PRs queued for merge (rebased / conflicts resolved this turn)
- **#340** per-tenant AI kill switch (rebased onto dev)
- **#342** spec edits for P2 #17/#18 (reality-delta.md conflict resolved — both appendices preserved)
- **#344** Idempotency-Key middleware + 24h cache (lint allowlist conflict resolved)
- **#351** token-gated `/api/public/chat/[token]` + customer quote view `/q/[token]` + AI mount on `/i/[token]` (call-wrapper.ts AICallPurpose conflict resolved)

Background `/tmp/atc-merge-final-p2.sh` is draining these now.

### Punch-list status after this session
- **P1 (12 items):** 100% closed
- **P2 (18 items):** all build items done or queued. 7 closed via spot-check verification (#22 #23 #27 #28 #29 + 2 from #346)
- **P3 cost-deferred:** unchanged (operator opt-in path documented)
- **P4 blocked-on-external:** unchanged (legal / operator decisions)
- **P5 future BPs:** unchanged
- **P6 docs:** unchanged

See `docs/specs/spec-gap-punch-list.md` for the updated state.

### Documented gaps from this session's work
- **Supervisor on token-gated chat surfaces** — the `/api/public/chat/[token]` endpoint (PR #351) ships without §10 supervisor coverage. Mitigated by strong system-prompt ground rules + read-only context (customer can't book/quote/change from chat — must use on-page actions). Tracked in route header + punch list follow-ups.

### Decisions logged this session
- **D-102** Token-gated public chat ships without §10 supervisor; mitigated by ground rules + read-only context. Supervisor wiring deferred as follow-up.
- **D-103** Customer-context system-prompt injection uses server-resolved refs (never client-supplied text) to defeat prompt injection. `resolveCustomerContext({ ref, tenant_id, db })` is the only path.

## In flight

Background merge script `/tmp/atc-merge-final-p2.sh` processing #340 → #342 → #344 → #351. Estimated 30-90 min depending on CI rerun cycles.

## Next step

Wait for the background merge cascade to complete. Once done, the punch list should reflect 0 open P2 build items.

If anything fails, hand-merge the residual.

## Blocked on user

Nothing.

## Open questions

- **Token-gated chat supervisor coverage** — should the next session wire the §10 supervisor pipeline through `/api/public/chat/[token]`? Adds operational complexity (need conversations row for the supervisor write-back) but closes a real safety gap on customer-facing AI surfaces.
- **Booking list page** — `/crm/bookings/[id]` exists now (PR #349) but `/crm/bookings` (the list) doesn't. Same pattern as quotes — minor gap, not on the punch list.

## Carried forward (unchanged from prior session)

- BP39 follow-up: retroactive react-pdf wire-up
- BP31: Haiku tolerable-PII redaction confidence/clarity scorer (cost-deferred — punch list P3 #32)
- BP30: AI behavior eval harness (cost-deferred — punch list P3 #35)
- BP25: PLATFORM_PEPPER offsite storage + DO-NOT-ROTATE doc (punch list P4 #46)
- BP24: populate `platform_settings.supervisor_slur_deny_list` (punch list P4 #45)
- BP23: populate `port_info_chunks` content for 17 ports (punch list P4 #44)
- BP16/17: counsel sign-off on ICA + AI Liability Disclaimer (punch list P4 #41)
- §13.9 active vs reactive health probing — operator decision (punch list P4 #48)
