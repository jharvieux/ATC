# Session state — last updated 2026-06-09 19:00 CT

## Just completed
- **D-193 logged — strategic pivot to BYO agents; personas go dual-role** (customer concierge + TA support/drafting assistant). Product decisions locked with operator: draft-only v1 (AI never sends), per-user voice profiles with tenant house-style default, TA chat covers travel expertise + platform how-to, persona picked by TA with system suggestion, Phase 3 intake is drag-and-drop (.eml / webmail selection / paste) with From-header → greeting name.
- Opened the three phase issues, each with cold-pickup detail + recommended design model: **#902** Phase 1 TA-mode chat (design: Opus), **#903** Phase 2 voice profiles (design: Sonnet), **#904** Phase 3 draft composer (design: Opus; flags `postal-mime` runtime-dep decision for operator).
- Installed `agent-installer` + `frontend-developer` community agents to `~/.claude/agents/` (operator-approved, content-reviewed; registered from next session).

## In flight
- Doc-only checkpoint PR for MEMORY D-193 + this SESSION update (branch `chore/checkpoint-d193`) — merge when checks pass.

## Next step
- Start **#902 Phase 1 (TA-mode chat)** design on Opus: audience dimension in `assemble-persona-prompt.ts`, tenant-dashboard chat surface, help-docs RAG ingestion scoped to tenant_member audience.

## Blocked on user
- #899 Vercel Hobby → Pro upgrade (dashboard action) — blocks #894 cron migration.
- Inngest dashboard verification that the 9 gated functions show archived (executions should drop to ~3.2k/day by June 11).
- PR #869 (stale June 8 checkpoint, DIRTY, contents already on dev) — recommended close; awaiting OK.
- #904 will need a runtime-dep call (`postal-mime` for .eml parsing) at design time.

## Open questions
- PR #898 (dependabot dev-deps): failing "Lint, Typecheck, Build" check — left to dependabot-retry-ci per triage rules; check next session whether it recovered.
- Prior items still open: #890 (inbound persona replies — now also the on-ramp for Phase-3 send-on-behalf), #885 (Playwright lightbox), #881 (CustomerContextChatPanel markers), #889 prod email-arrival verify.
