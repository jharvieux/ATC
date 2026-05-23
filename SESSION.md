# Session state — last updated 2026-05-22 23:20 UTC

## Just completed
- BP24: Chat UI — tone matching, deterministic hate-speech deny-list, anon + customer chat rate limits (§24) — PR #71 merged to dev
  - Migration 20260603000000_chat_ui.sql: tenant_settings tone/safety columns, customer_memories.rapport_tone_directive, anonymous_chat_counters, customer_chat_counters + customer_chat_tenant_overrides, resolve_customer_chat_caps SQL function, 18 platform_settings seeds
  - 14 new env vars (anon caps, customer caps, cooldowns, hard ceiling/floor, soft prompts)
  - lib/chat/: tone-resolution, persona-base-tones, customer-tone-override, fingerprint, anonymous-limit, customer-limit (Haiku hard-limit summary)
  - Supervisor finalized: tone-drift async with Haiku heuristic + by-hash details; run-supervisor unions platform + tenant supplemental deny-lists with audit-by-hash on every match; HATE_SPEECH_REGEN_INSTRUCTION exported
  - Chat backend (six routes replace 501 stubs): POST /api/chat (full orchestration + SSE word-replay), conversations list/get/PATCH, persona switch, feedback, escalate
  - Admin denylist /admin/denylist page + API (count + hashes only — never the term)
  - Tenant admin /tenant-admin/safety + /tenant-admin/chat-limits (Pro+ gated)
  - Chat UI: /chat page (desktop 3-pane + mobile single-pane), persistent AI disclosure banner, StreamingArea (IntersectionObserver auto-scroll + "New message" indicator), MessageBubble (avatar/sources/copy/feedback/memory tooltip), SignupWall (no identifier reveal), HardLimitMessage (platform-spoken)
  - 3 Inngest crons: anonymous-chat-counter-cleanup, customer-chat-counter-recompute, denylist-quarterly-review-reminder
  - 5 new test files, 33 new tests; all 466 tests pass; CI all green
  - MEMORY D-057 with 15 decisions documented

## In flight
- Nothing in flight — clean checkpoint

## Next step
- Switch model back to Sonnet 4.6: `/model claude-sonnet-4-6`
- Begin BP25 — first prompt in Part 6 (data privacy & retention §25)

## Blocked on user
- Nothing

## Open questions
- Operator content task: populate `platform_settings.supervisor_slur_deny_list` (still seeded `[]` from BP11 D-046; deny-list infrastructure ready but list is empty)
- Operator tasks for BP24:
  - Apply migration 20260603000000_chat_ui.sql to atc-main
  - Confirm ANTHROPIC_API_KEY set in Vercel (chat handler requires it)
  - Walk /chat once deployed to staging (anon + authenticated; both rate-limit branches)
- Carry-over from prior BPs: audit_log real-INSERT swap (D-036), port_info_chunks content (BP23), weather integration, Gmail inbound, contacts FK
