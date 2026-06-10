# Session state — last updated 2026-06-09 20:00 CT

## Just completed
- **#902 PR A merged (PR #909, 630da4bf) — TA-mode chat API complete (D-196).** Audience gate (`mode:"ta"` → server-verified tenant_owner/agent, 403 fail-closed), TA register via `TA_MEMBER_RULES` Layer-2 swap (customer prompts byte-identical, equality-tested), `buildHelpContextBlock` (title-hit qualified), `ta_chat_main` purpose, 200/day/member fail-closed cap, `conversations.audience` column (migration **applied to prod DB**), cross-register continuation blocked, own-only TA-thread guard. Both Opus audits clean. Checkpoint #910 merged (83a89d07).
- D-193/D-194/D-195 logged earlier this session (BYO pivot; phase issues #902/#903/#904; .msg in scope; design approved via PR #907).
- Issues filed from findings: **#906** (Help AI ungrounded), **#908** (SECURITY: conversations RLS tenant-level only).

## In flight
- Nothing in flight — clean checkpoint.

## Next step — model plan agreed with operator (2026-06-09)
Run these on **Sonnet**, in order (each independently shippable):
1. **#902 PR B — tenant-dashboard chat surface.** Page in `(tenant)` route group (e.g. /concierge), nav entry, persona picker, reuse chat components with `mode:"ta"`, plus a TA-audience conversation-list endpoint that MIRRORS the PR A role gate (tenant_owner/agent, own threads only). Design: docs/byo-agents/902-ta-mode-chat-design.md §UI. NOTE: new API route → **Opus first-audit** still applies.
2. **#906 — help_ai grounding retrofit.** Wire `buildHelpContextBlock` into the help_ai message route on `session_type === "help"` turns. Issue body is the spec.
3. **#866 — streaming cost-state enforcement.** Mirror call-wrapper's `ai_cost_state='hard'` refusal into stream-wrapper. Reference implementation is in the sibling file.

**#908 (conversations RLS tightening) is NOT for Sonnet's design pass** — schedule as its own session with reader enumeration + policy design on Opus (or fable); implementation can then drop to Sonnet. Risky surface: anon conversations, service-role writers, CRM timeline readers, staff-vs-owner asymmetry; RLS migration → Opus first-audit.

## Blocked on user
- #899 Vercel Hobby → Pro upgrade — blocks #894 cron migration.
- Inngest dashboard verification (9 gated functions archived; executions ~3.2k/day by June 11).
- PR #869 (stale June 8 checkpoint, DIRTY, contents already on dev) — recommended close; awaiting OK.

## Open questions
- PR #898 (dependabot): failing "Lint, Typecheck, Build" left to dependabot-retry-ci — re-check next session.
- Prior items: #890 (inbound persona replies), #885 (Playwright lightbox), #881 (panel markers), #889 prod email-arrival verify.
