# Session state — last updated 2026-07-27 12:00 CT

## Just completed
- PR #2049 merged (MEMORY-INDEX split, D-366) — carried over from the prior session.
- `/issue-sweep` hardening applied to BOTH variants — the project one (`.claude/commands/issue-sweep.md`, PR #2051, merged) and the portable user-level one (`~/.claude/commands/issue-sweep.md`, outside the repo, edited directly):
  - SESSION.md checkpointed at five milestones (plan posted, approval recorded, every batch terminal transition, fold-in round start, wrap-up) — supervisor only, since executors sit in worktrees.
  - Executors no longer write instruction/state files; they return `claude_md_updates` (`instruction_updates` in the portable variant) with an `invalidated` flag, consolidated into one operator-approved table at wrap-up.
  - Workspace hygiene: prune agent worktrees + delete merged `feature/sweep-*` branches before triage, per batch at finalization, and after the last merge.
  - Plan gate leads with four tables: sweep profile, execution plan, decisions-needed (answerable by number), not-being-worked.
  - Independent acceptance-criteria verification before every merge by a non-executor subagent — all met closes, partial closes-and-splits, unmet reopens and re-queues; applies to `closed_stale` too, plus a whole-close-set re-check at wrap-up.
  - Phase 4 fold-in rounds: remainders, verifier reopens, and unblocked follow-ups re-enter the same sweep under the original approval, capped at 3 rounds with a `fold_depth > 1` disqualifier. Net-ledger line now counts only issues left open at the end.
- Three of those rules promoted into CLAUDE.md (PR #2052, merged): subagents never write `MEMORY.md`/`MEMORY-INDEX.md`/`SESSION.md`/`CLAUDE.md`/runbooks; closing an issue requires per-criterion evidence; pruning your own agent worktrees is allowed.
- D-367 logged for the above.

## In flight
- Branch `docs/d367-sweep-hardening` — MEMORY.md + MEMORY-INDEX.md + SESSION.md, PR open into `dev`, awaiting required CI. Nothing else uncommitted.

## Next step
- Merge the D-367 PR once required CI is green, then delete the branch.

## Blocked on user
1. **Old Stripe account webhook endpoint**: disable/delete the endpoint pointing at https://ai-travelconcierge.com/api/webhooks/stripe/platform in the OLD Stripe account, or its failing deliveries keep generating warning emails.
2. **Prod release including bba75c0e** — crons stay dead in prod until the cron fix ships (operator-gated release).
3. Carried: #1740 prod DDL repair (2 statements on atc-main); atc-rag manual prod deploy (`cd apps/rag && vercel deploy --prod --yes`); extension smoke test (post-#2015); #2025 time-boxed check (~Jul 22, 48h after the last prod deploy).
4. ~18 stale worktrees + ~95 stale remote sweep branches still await sign-off for deletion. The new CLAUDE.md carve-out covers pruning agent worktrees under `.claude/worktrees/`, but the remote-branch bulk delete is still the operator's call.

## Open questions
- The portable `/issue-sweep` lives outside version control, so the two variants can drift silently. Worth deciding whether one should be generated from the other rather than hand-synced — not filed as an issue, since it isn't a repo defect.
- After the next prod release (which picks up bba75c0e), confirm in Vercel runtime logs that `/api/cron/*` returns 200/401 instead of 404; #2047 (assertCronAuth hardening) is the natural next code item. If crons return 401 instead of 200, CRON_SECRET in Vercel doesn't match what Vercel sends.
- MEMORY-INDEX curation: standing pre-D-311 keeps are D-131/133/137/151/176/181/182/233/247/261/265/272/278–281/288/291/292/295. Moving a line between index and archive is a two-line edit; the guard enforces exactly-one-file placement.
- Carried: alert #103 CodeQL verification.
