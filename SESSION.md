# Session state — last updated 2026-06-09 19:40 CT

## Just completed
- **#902 PR A merged (PR #909, 630da4bf) — TA-mode chat API complete (D-196).** Audience gate (`mode:"ta"` → server-verified tenant_owner/agent, 403 fail-closed), TA register via `TA_MEMBER_RULES` Layer-2 swap (customer prompts byte-identical, equality-tested), `buildHelpContextBlock` (title-hit qualified, in-process docs loader), `ta_chat_main` purpose, 200/day/member fail-closed cap, `conversations.audience` column (migration **already applied to prod DB** via MCP), cross-register continuation blocked, own-only TA-thread guard. Both Opus audits clean.
- **#902 design approved + shipped earlier (D-195, PR #907):** docs/byo-agents/902-ta-mode-chat-design.md.
- Issues filed from findings: **#906** (Help AI claims doc grounding, never receives docs), **#908** (SECURITY: conversations RLS tenant-level only — any member can read any conversation by id; TA threads guarded in PR A, customer threads still exposed).
- D-193/D-194 logged earlier this session (BYO pivot, phase issues #902/#903/#904, .msg in scope for #904).

## In flight
- Nothing in flight — clean checkpoint. dev = PR #909 squash merge; beta pipeline deploys atc-main on the merge (no rag changes).

## Next step
- **#902 PR B: tenant-dashboard chat surface** — page in `(tenant)` route group (e.g. /concierge), nav entry, persona picker, reuse chat components with `mode:"ta"`, TA conversation list (needs a TA-audience listing endpoint with the same role verification; customer list endpoint already excludes TA threads).
- Then: #906 retrofit (tiny — wire buildHelpContextBlock into help_ai message route), and #908 deserves prioritization (security).

## Blocked on user
- #899 Vercel Hobby → Pro upgrade — blocks #894 cron migration.
- Inngest dashboard verification (9 gated functions archived; executions ~3.2k/day by June 11).
- PR #869 (stale June 8 checkpoint, DIRTY, contents already on dev) — recommended close; awaiting OK.
- #908 priority call: security finding, customer-thread exposure is pre-existing but real.

## Open questions
- PR #898 (dependabot): had a failing "Lint, Typecheck, Build" check, left to dependabot-retry-ci — re-check next session.
- #866 (streaming bypasses hard cost state) now matters more: TA chat streams; the 200/day cap is the effective stop until fixed.
- Prior items: #890 (inbound persona replies), #885 (Playwright lightbox), #881 (panel markers), #889 prod email-arrival verify.
