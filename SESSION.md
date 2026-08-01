# Session state — last updated 2026-07-31 (issue-sweep #8 complete)

## Just completed
- **Issue sweep #8** (Fable executors, operator-trimmed to 2 batches + 1 fold-in): 3 PRs merged, 5 issues closed, 2 filed — tracker 47 → 44 open, **down 3 on the day**.
  - PR #2068 — #2050 cross-tenant storage read fixed (opaque id + tenant-scoped lookup).
  - PR #2070 — #2002 (partial→#2069)/#2004/#2047 seam-secret rotation sets; Opus audit caught a CRON_SECRET boot blocker pre-merge (would have silently killed all 9 crons on first rotation).
  - PR #2071 — #2069 boot-required flip + e2e placeholder; MAIN_APP_ADMIN_API_KEY added to Vercel **Preview** with a random placeholder value.
- D-370 logged (rotation-set strategy FINAL for #2002, supersedes queued service-JWT). anti-patterns.md #28 + vercel-env-checklist.md updated (both were invalidated by the merges). #2072 filed (help-docs bucket SELECT policy, needs supervised migration).

## In flight
- Wrap-up docs PR (MEMORY.md D-370, MEMORY-INDEX.md, anti-patterns.md, vercel-env-checklist.md, SESSION.md) — being opened now; merge on green.

## Next step
- Merge the wrap-up docs PR, delete `.git/issue-sweep-ledger.json`, done.
- Batches 3–7 from the sweep plan were trimmed at the gate and remain open: tests-2028 (#2028/#2040), extension-2039, retention-2037, chat-zod-2014, scripts-2019; plus proposed read-only prod checks (#1838/#2043/#2044). Re-run /issue-sweep or say "run the rest" to pick them up.

## Blocked on user
1. **Preview seam value is a placeholder** — replace atc-main Preview `MAIN_APP_ADMIN_API_KEY` with the real bearer if preview RAG↔main auth is ever needed.
2. Unanswered gate rows from this sweep: hygiene deletions (dirty worktree `agent-a1ca5e7b04dead54c`, scratchpad worktree `atc-m8-check`, branches `sweep-cron-1581-audit-tmp` +7 / `sweep-security-1598` +1).
3. Carried: ROTATE MTC-COM-9V5ZKDJC5TI0 (memtrace key, .codex/config.toml); sitemap submission; old Stripe webhook disable; prod release incl. bba75c0e; #1740 prod DDL repair; atc-rag manual deploy; extension smoke test; #2025 time-boxed check (needs that prod release first).

## Open questions
- Residual accepted nit on PR #2070: proxy comment slightly conflates the two bearer-admitted path groups' auth mechanisms (wording only, test-covered) — accepted rather than staling markers for a comment edit.
- Carried: homepage-as-agency-landing confirmation in prod; post-release cron verification; alert #103 CodeQL verification.
