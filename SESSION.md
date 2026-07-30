# Session state — last updated 2026-07-30 CT

## Just completed
- **PR #2063 merged** (`c8792538`) — six portable-copy `/issue-sweep` lessons backported into the repo skill (pnpm worktree hazard, dispatch ordering, test-the-premise, prefer-repo-agent, executors-never-wait, forge-derived counts).
- **PR #2065 merged** (`c556dd26`) — all four improvements from the skill review implemented, D-369 logged:
  1. `.claude/agents/sweep-executor.md` + `.claude/agents/acceptance-verifier.md` now own the executor standing rules and verifier spec; the skill dispatches via `subagent_type` and forbids restating rules in prompts.
  2. Phase 1 fetch completeness check (`--limit` truncates silently) — both copies.
  3. Copy-sync protocol: both copies carry `<!-- sync-token: 1 -->`; workspace hygiene compares them; a lone bump in the portable copy (edited from any project) is the backport signal.
  4. `claude_md_updates` → `instruction_updates` in the repo copy (matches portable; `memory_entry` stays).
- Backported the two newest portable-copy lessons into the repo copy: `blocked_on`/`next_action` ledger fields, and the "every open PR must be attributable to something that is NOT you" turn-exit condition.
- Portable copy (`~/.claude/commands/issue-sweep.md`) updated in place: spliced-bullet fix, sync-token + Copy-sync protocol, fetch completeness check, hygiene sync check. **Both copies are at sync-token 1.**

## In flight
- Nothing in flight — clean checkpoint. On `dev`, synced with origin. `.codex/` and `AGENTS.md` remain untracked working-tree files (unchanged, not committed).

## Next step
- Nothing queued. The next `/issue-sweep` run will exercise the new agents (`sweep-executor`, `acceptance-verifier`) for the first time — watch that dispatches carry only batch specifics and that the agents' return JSON parses as expected.

## Blocked on user
1. **ROTATE `MTC-COM-9V5ZKDJC5TI0`** (memtrace license key, `.codex/config.toml`) — key reached GitHub in a since-rebuilt branch; treat as exposed. Also consider gitignoring `.codex/`.
2. **Submit the sitemap** to Google Search Console and Bing Webmaster Tools once `6a982a70` reaches production.
3. Carried: old Stripe account webhook endpoint still needs disabling; prod release including `bba75c0e` (crons dead in prod until then); #1740 prod DDL repair; atc-rag manual prod deploy; extension smoke test; #2025 time-boxed check.
4. Carried: ~18 stale worktrees + ~95 stale remote sweep branches await deletion sign-off.

## Open questions
- Optional extra for portable-copy history: turning `~/.claude` (or just its `commands/`) into a git repo would give the portable skill version history across projects; the sync-token protocol works without it. Operator's call, not urgent.
- Carried: homepage-as-agency-landing product shift worth confirming in production; #2058 custom-domain indexing opt-in declined this round; post-release cron verification in Vercel logs; alert #103 CodeQL verification.
