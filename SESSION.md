# Session state — last updated 2026-06-12 (post-merge of PR #1022)

## Standing rule (operator, permanent)
**No prod DB changes or manual prod deploys without per-instance operator approval.** Dev-merge pipeline stays autonomous.
**Note (D-205):** there is currently ONE Supabase project (mfaknjyqiwcjojukcnea) serving production — MCP applies ARE prod applies. Gate accordingly until #386/#534 split environments.

## Just completed (this session)
- **PR #1022 merged into dev** (#1016 closed): `runGenerationLoop` extracted from `handleChat()` into `apps/main/src/lib/chat/run-generation-loop.ts`. Resumed the prior session's uncommitted round-2 audit fixes, fixed a typecheck error in them, verified, pushed (8efa5b70), re-ran both audit agents (clean), updated the PR audit body, merged, branch deleted. Logged as D-213.
- Opened issue **#1023**: the D-091 `service-role-tenant` detector can't see modules that receive the service-role client as a parameter (surfaced by the extraction).
- The #1015 + #1016 chat-route split from the Vitals scan (D-212) is now fully shipped.

## In flight
- Nothing in flight — clean checkpoint. Local is on `dev`, fast-forwarded to 221fd1cf.

## Next step
- No queued work. Candidates if the operator wants one picked up: #1023 (detector gap, well-specified), #1010 (vendor-health split-brain), or the deferral queue (#1002, #1003).

## Blocked on user
- Nothing.

## Open questions (carried over)
- #1003: D-201 narrowing — reviewer scope/mechanism (user chose to defer)
- #1008: theming sweep for remaining customer surfaces (deferred from PR #1009)
- Untracked `headroom_memory.db` at repo root (headroom MCP artifact) — left untracked; consider gitignoring in a future PR.
