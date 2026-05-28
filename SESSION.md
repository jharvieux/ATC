# Session state — last updated 2026-05-28 ~03:00 UTC (overnight close)

## Just completed

Overnight autonomous run. Closed F1 + F2 + F3 + #56 + #58 (partial) + #59 + persona-backstory verification. Earlier this session: full P1 + P2 close-out + Node version cleanup.

### PRs merged this session
- **#331–#351** see prior SESSION snapshot — full P1/P2 close-out + customer AI panel + spec edits
- **#328** canonical-domain rename (rebased after sitting unmerged) — applied to help docs (`03-branding.md`, `08-usage-and-billing.md`)
- **#349** booking-detail page (P2 #24)
- **#350** quote-builder co-pilot (P2 #25)
- **#352** session+memory+punchlist update
- **#353** `.nvmrc` + workflow conversion (fix Node 20 deprecation warnings)
- **#354** F2 (booking list page) + F3 (PATCH state-machine gating)
- **#355** #59 AI-mode cost-display + projection
- **#356** persona ↔ backstory verification (no edits — all 6 personas aligned with the doc); commits `specs/TechSpec/agent-backstories-photo-guide.md` extracted from `Review/`

### PRs opened overnight (in flight)
- **#357** F1 — full supervisor pipeline on `/api/public/chat/[token]`. Adds `public_token_chat` source kind to TenantContext, `tenantContextForPublicTokenChat` factory, `conversations.public_access_token_hash` column (migration `20260627000008`). Closes D-102.
- **#358** P5 #56 — persona tools registry with full dispatch. 3 real handlers (escalate_to_human, get_customer_context, update_memory), 3 honest placeholders (search_host_inventory, generate_quote, collect_booking_details — each returns structured `not_implemented` + `can_fall_back_to: escalate_to_human`). Wired into `/api/chat` non-streaming branch; streaming-mode + ai_tool_calls audit table are follow-ups.
- **#359** P5 #58 (partial) — wired Stage 1 prefetch+save end-to-end + built the `/booking/confirmation/[id]` landing page Stage 4 was redirecting to. Stages 2/3 deferred (need new tables / endpoints).

### Punch-list close-outs this overnight
- **F1** supervisor on token-gated chat — ✅ #357
- **F2** booking list page — ✅ #354
- **F3** booking PATCH state-machine — ✅ #354
- **P5 #56** persona tools registry + dispatch — ✅ #358 (3 real + 3 placeholder)
- **P5 #58** customer booking flow UI — 🟡 #359 (Stage 1 + confirmation page only; Stages 2/3 deferred)
- **P5 #59** AI-mode cost display — ✅ #355
- **Persona ↔ backstory verification** — ✅ #356 (no edits needed)

### Decisions logged this session
- **D-102** Token-gated public chat ships without §10 supervisor (LATER closed in #357)
- **D-103** Customer-context system-prompt injection uses server-resolved refs

### Documented gaps still open
- **Dependabot PRs #329 #330** — both have real CI failures (Lint, Typecheck, Build, Test fail — not just Vercel). Version bumps must be breaking something. Need human investigation before merge.
- **Streaming-mode tool support** in `/api/chat` — non-streaming branch wires tools; streaming branch unchanged. Material work (delta buffering + partial tool_use blocks).
- **`contact_id` threading** in chat tool dispatch — hardcoded to `null` today. Small touch to pull from the conversation row.
- **Booking flow Stages 2/3** — passenger details + options scaffolding intact but not wired. Need `booking_passengers` CRUD + an addons table.
- **`ai_tool_calls` audit table** — recommended for queryable post-hoc analysis of which tools fired when.

## In flight

Background merge script `/tmp/atc-merge-overnight-final.sh` processing #357 → #358 → #359. Estimated 15-30 min depending on CI rerun cycles.

This docs PR (`docs/overnight-session-wrap`) is separate and will need its own merge.

## Next step

1. Wait for background merge cascade. If anything fails (DIRTY conflict — likely on `apps/main/src/lib/ai/call-wrapper.ts` since #357 and #358 both touch `AICallPurpose`), resolve and retry.
2. Investigate dependabot #329/#330 failures. Pin to safe versions if a transitive dep broke something.
3. Optional: book Stages 2/3 wiring follow-up. Tables + endpoints first.

## Blocked on user

- **Dependabot #329 / #330** failing CI — needs decision: bump anyway with version-pin escape hatch, or hold until upstream fixes? Look at the actual failure output before deciding.
- **Streaming tool-use support** — non-streaming is wired but streaming is a real chunk of work. Worth doing? Or accept streaming users get the response without tool calls?

## Open questions

- **Persona tool follow-ups**: 3 of the 6 tools (search_host_inventory, generate_quote, collect_booking_details) ship as honest placeholders. Should real implementations happen alongside their owning BPs (BP14 host adapter, §38 quote builder, §20.4 booking submit) or as standalone work?
- **`ai_tool_calls` audit table** — yes/no for queryable history of tool dispatches? Tonight's logging is just `console.info`.

## Carried forward (unchanged from prior session)

- BP39 follow-up: retroactive react-pdf wire-up
- BP31: Haiku tolerable-PII redaction confidence/clarity scorer (cost-deferred — punch list P3 #32)
- BP30: AI behavior eval harness (cost-deferred — punch list P3 #35)
- BP25: PLATFORM_PEPPER offsite storage + DO-NOT-ROTATE doc (punch list P4 #46)
- BP24: populate `platform_settings.supervisor_slur_deny_list` (punch list P4 #45)
- BP23: populate `port_info_chunks` content for 17 ports (punch list P4 #44)
- BP16/17: counsel sign-off on ICA + AI Liability Disclaimer (punch list P4 #41)
- §13.9 active vs reactive health probing — operator decision (punch list P4 #48)
