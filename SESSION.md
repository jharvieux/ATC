# Session state — last updated 2026-05-27 ~19:00 UTC

## Just completed

Full Claude Code setup session, plus the Next 16 fallout it surfaced. 9 PRs merged into `dev` (#318–#326). All checks green; Vercel rate-limit-exempt per user authorization.

### PRs merged this session
- **#318** d091-reviewer subagent (`.claude/agents/d091-reviewer.md`) — read-only auditor for the 14 D-091 anti-patterns from CLAUDE.md
- **#319** PreToolUse hook blocking edits to `specs/**` and non-prepend writes to `MEMORY.md`
- **#320** CI unblocker — GitHub App env-var placeholders in `.github/workflows/e2e.yml`. Playwright had been silently red since the Next 14 → 16 bump
- **#321** `envBoolean()` helper replaces all 28 `z.coerce.boolean()` callsites in `apps/main/src/lib/env.ts` (silent kill-switch flip bug). 25 unit tests pin the behavior; bp29 schema-discipline regex updated to recognize the new helper
- **#322** PostToolUse hook running eslint on every TS/TSX edit in `apps/main` or `apps/rag` (~0.8s)
- **#323** `apps/main/src/middleware.ts` → `proxy.ts` (Next 16 deprecation). Function rename + test rename + stryker config + one comment path-reference
- **#324** `docs/site-urls.md` — inventory of browser-accessible pages by host context
- **#325** `/memory-entry` slash command + `docs/local-development.md` updated with the BP31 GitHub App env vars
- **#326** Stop hook running `tsc --noEmit` at turn-end on workspaces with uncommitted TS changes. Plus stryker stale-entry cleanup (removed `apps/rag/src/middleware.ts` from mutate config — file never existed)

### Per-user / non-PR work
- Two Supabase MCP servers wired locally (`supabase-main` + `supabase-rag`), user-scoped, `--read-only`, scoped to one project-ref each
- Local dev server unwedged. Same Next 16 instrumentation root cause as #320 — `apps/main/.env.local` was missing the BP31 GitHub App vars; placeholders appended
- Comprehensive Next 16 breakage sweep across 20 known patterns; only finding outside what we fixed was the middleware → proxy rename (#323)

### Decisions logged tonight
- **D-099** Claude Code automation infrastructure (subagent, 3 hooks, slash command, MCPs, setup runbook)
- **D-100** `z.coerce.boolean()` JS gotcha → `envBoolean()` helper at all 28 sites
- **D-101** Next 16 instrumentation timing change → env-var placeholder cascade

## In flight

Nothing in flight — clean checkpoint.

## Next step

1. **Switch model back to Sonnet** — `/model claude-sonnet-4-6`. Standing rule per CLAUDE.md at end of an Opus session.
2. **Optional** — rotate the Supabase PAT pasted into this transcript (read-only, scoped to two project-refs; not urgent). Generate fresh at https://supabase.com/dashboard/account/tokens, re-run the two `claude mcp add supabase-*` commands, revoke the old one.
3. **Optional** — open-source-extraction question (eslint-plugin-atc / safe-mutation as MIT-licensed standalone npm packages) was discussed but not actioned. Revisit after PMF / first revenue per the conversation.

## Blocked on user

Nothing.

## Open questions

- Whether to extract `packages/eslint-plugin-atc` or `apps/main/src/lib/db/safe-mutation.ts` as MIT-licensed standalone packages for credibility/recruiting. Conversation captured in chat; not yet decided.
- Whether to pursue the full-repo AGPL path for the main product. Process and gotchas walked through in chat; deferred until post-PMF.

## Carried forward (unchanged from prior session)

- BP39 follow-up: retroactive react-pdf wire-up
- BP31: Haiku tolerable-PII redaction confidence/clarity scorer (cost-deferred)
- BP30: AI behavior eval harness (cost-deferred)
- BP25: PLATFORM_PEPPER offsite storage + DO-NOT-ROTATE doc
- BP24: populate `platform_settings.supervisor_slur_deny_list`
- BP23: populate `port_info_chunks` content for 17 ports
- BP16/17: counsel sign-off on ICA + AI Liability Disclaimer
- §13.9 active vs reactive health probing — operator decision
- §20.4 / §38.8 / §38.8.1 / §39.5 — customer-facing AI chat panels build (~2 days, browser testing)
