# Session state — last updated 2026-07-30 CT

## Just completed
- **PR #2063 merged** (squash, `c8792538`) — backported six portable-copy `/issue-sweep` lessons into the repo skill: worktree-removal pnpm-symlink hazard (`CI=true pnpm install` repair), dispatch ordering for batches sharing a predicted file, test-the-premise rule at the plan gate, prefer-repo-defined-agent over retyped canonical block, executors-never-wait/watch/poll, wrap-up counts derived from `gh search` (never a hand-kept tally; `gh issue list --limit N` silently truncates). Also added "do not merge" to the executor PR-open rule.
- Fixed a formatting bug in the **user-level** portable copy (`~/.claude/commands/issue-sweep.md`): a pnpm bullet had been spliced into the middle of the "Never touch" bullet, orphaning "an open PR." — reassembled both bullets. (Outside version control; no PR.)
- The two `/issue-sweep` copies are now content-synced as of 2026-07-30 (repo copy carries ATC specifics; portable copy carries the Phase-0 profile-resolution layer).

## In flight
- Nothing in flight — clean checkpoint. On `dev`, synced with origin. `.codex/` and `AGENTS.md` remain untracked working-tree files (unchanged, not committed).

## Next step
- Operator to rule on the recommendations from the 2026-07-30 skill review (not yet filed as issues, awaiting their call):
  1. Create `.claude/agents/sweep-executor.md` + `.claude/agents/acceptance-verifier.md` so the canonical safeguard block lives in one reviewed place instead of being retyped per dispatch (the skill now points at them if they exist).
  2. Phase 1 fetch uses `gh issue list --limit 200` — same silent-truncation class the wrap-up lesson warns about; add a completeness check (compare against `gh search issues --repo ... state:open` count) in both copies.
  3. Portable-copy drift management: the user-level copy lives outside version control and drifts (this session's backport is the second manual sync); consider making the repo copy canonical with a diff check, or versioning the portable copy elsewhere.
  4. Field-name divergence: portable ledger uses `instruction_updates`, repo uses `claude_md_updates` + `memory_entry` — harmless today but a copy-paste hazard when syncing; consider aligning names.

## Blocked on user
1. **ROTATE `MTC-COM-9V5ZKDJC5TI0`** (memtrace license key, `.codex/config.toml`) — key reached GitHub in a since-rebuilt branch; treat as exposed. Also consider gitignoring `.codex/`.
2. **Submit the sitemap** to Google Search Console and Bing Webmaster Tools once `6a982a70` reaches production.
3. Carried: old Stripe account webhook endpoint still needs disabling; prod release including `bba75c0e` (crons dead in prod until then); #1740 prod DDL repair; atc-rag manual prod deploy; extension smoke test; #2025 time-boxed check.
4. Carried: ~18 stale worktrees + ~95 stale remote sweep branches await deletion sign-off.

## Open questions
- Recommendations 1–4 above (sweep-skill follow-ups) — file as issues once the operator picks.
- Carried: homepage-as-agency-landing product shift worth confirming in production; #2058 custom-domain indexing opt-in declined this round; post-release cron verification in Vercel logs; alert #103 CodeQL verification.
- ~~Portable `/issue-sweep` drift~~ — synced 2026-07-30 (see Just completed); the *process* question (how to stop it drifting again) is recommendation 3.
