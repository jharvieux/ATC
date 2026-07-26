# Session state — last updated 2026-07-25 21:15 CT

## Just completed
- /doctor health check of the Claude Code setup (local config, not repo): disabled unused MCP servers (headroom, memtrace) + plugins (claude-code-setup, frontend-design); rewired the RTK PreToolUse rewrite hook user-scope (~/.claude/hooks/rtk-rewrite.mjs) so read/report Bash commands route through rtk in every project; operator declined the bypassPermissions→auto default-mode switch.
- PR #2049 opened (in flight below): MEMORY-INDEX split — lean 75-line index (standing rules + D-311+) stays the session-start read; 268 one-liners moved to new MEMORY-INDEX-ARCHIVE.md; check:memory-decision-collision now validates MEMORY.md vs the UNION of both files + fails on overlap (findIndexOverlap, 4 new tests); CLAUDE.md trimmed ~550 tokens (MEMORY prepend mechanics → /memory-entry, which also gained the missing index-prepend step; audit model-selection → pr-workflow.md pointer). D-366 logged. Saves ~10.5k est. tokens per session start.

## In flight
- PR #2049 (branch docs/memory-index-split-claude-md-trim): pushed through 96c38390, pnpm verify green locally, both audit agents launched (Sonnet) concurrent with CI. Remaining: audit markers post → rerun pr-audit-section-check gate → squash-merge, delete branch.

## Next step
- Finish PR #2049 merge (see In flight). Then: after the next prod release (which picks up bba75c0e), confirm in Vercel runtime logs that /api/cron/* returns 200/401 instead of 404; #2047 (assertCronAuth hardening) is the natural next code item.

## Blocked on user
1. **Old Stripe account webhook endpoint**: disable/delete the endpoint pointing at https://ai-travelconcierge.com/api/webhooks/stripe/platform in the OLD Stripe account, or its failing deliveries keep generating warning emails.
2. **Prod release including bba75c0e** — crons stay dead in prod until the cron fix ships (operator-gated release).
3. Carried: #1740 prod DDL repair (2 statements on atc-main); atc-rag manual prod deploy (`cd apps/rag && vercel deploy --prod --yes`); extension smoke test (post-#2015); #2025 time-boxed check (~Jul 22, 48h after the last prod deploy).

## Open questions
- MEMORY-INDEX curation: standing pre-D-311 keeps are D-131/133/137/151/176/181/182/233/247/261/265/272/278–281/288/291/292/295. Moving a line between index and archive is a two-line edit; the guard enforces exactly-one-file placement.
- Once #2045's fix is live in prod: if crons return 401 instead of 200, CRON_SECRET in Vercel doesn't match what Vercel sends — check project settings.
- Carried: alert #103 CodeQL verification; ~18 stale worktrees + ~95 stale remote sweep branches await operator sign-off for deletion.
- /doctor flagged the vercel plugin as the biggest context consumer (~5.3k est. tokens/session); no action — heavily used.
