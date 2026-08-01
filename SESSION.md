# Session state — last updated 2026-08-01 (session ended after sweep #8 + dependabot triage)

## Just completed
- **Issue sweep #8** (Fable executors, operator-trimmed to 2 batches + 1 fold-in): 3 PRs merged, 5 issues closed, 2 filed — tracker 47 → 44 open, **down 3 on the day**.
  - PR #2068 — #2050 cross-tenant storage read fixed (opaque id + tenant-scoped lookup).
  - PR #2070 — #2002 (partial→#2069)/#2004/#2047 seam-secret rotation sets; Opus audit caught a CRON_SECRET boot blocker pre-merge (would have silently killed all 9 crons on first rotation).
  - PR #2071 — #2069 boot-required flip + e2e placeholder; MAIN_APP_ADMIN_API_KEY added to Vercel **Preview** with a random placeholder value.
- D-370 logged (rotation-set strategy FINAL for #2002, supersedes queued service-JWT). anti-patterns.md #28 + vercel-env-checklist.md updated (both were invalidated by the merges). #2072 filed (help-docs bucket SELECT policy, needs supervised migration).

## In flight
- Wrap-up docs PR #2074 — MERGED (sweep #8 fully closed out; ledger deleted).
- **Dependabot triage 2026-07-31/08-01**: 16 alerts, all real (no phantom lockfile). PRs #2054/#2073/#2056/#2062 cover 15; all blocked by the pnpm minimumReleaseAge guard on two transitives published 2026-07-31 (baseline-browser-mapping@2.11.9, fast-uri@3.1.5 — age out by ~11:06 CT Aug 1). **One-time cloud routine `trig_01Ck4RNiBqF4ZHGjxeugVdLi` fires 11:30 CT Aug 1** to rebase+merge the train serially and open the bounded `sharp: ^0.35.0` override PR for alert 47 (next 16.2.11 still pins ^0.34.5). Routine will NOT weaken policies; real failures (watch #2056 Dependency Review, #2062 Typecheck) get left open + reported. Routines UI: https://claude.ai/code/routines
- Hygiene deletions executed on operator order: 172 worktree-agent-* branches, 2 stale worktrees, 2 held sweep branches. `sweep-ops-1159-fix` (no PR) left — not on the approved list.

## Next step
- **Check the dependabot routine's report** (fires 11:30 CT Aug 1, routine `trig_01Ck4RNiBqF4ZHGjxeugVdLi`): expect 4 merged PRs + a sharp-override PR; its report says which of the 16 alerts cleared. If the sharp-override PR is left open on the audit gate, run the audit agents on it or merge per its report.
- Sweep batches 3–7 trimmed at the gate remain open: tests-2028 (#2028/#2040), extension-2039, retention-2037, chat-zod-2014, scripts-2019; plus proposed read-only prod checks (#1838/#2043/#2044). Re-run /issue-sweep or say "run the rest".

## Blocked on user
1. **Preview seam value is a placeholder** — replace atc-main Preview `MAIN_APP_ADMIN_API_KEY` with the real bearer if preview RAG↔main auth is ever needed.
2. Unanswered gate rows from this sweep: hygiene deletions (dirty worktree `agent-a1ca5e7b04dead54c`, scratchpad worktree `atc-m8-check`, branches `sweep-cron-1581-audit-tmp` +7 / `sweep-security-1598` +1).
3. Carried: ROTATE MTC-COM-9V5ZKDJC5TI0 (memtrace key, .codex/config.toml); sitemap submission; old Stripe webhook disable; prod release incl. bba75c0e; #1740 prod DDL repair; atc-rag manual deploy; extension smoke test; #2025 time-boxed check (needs that prod release first).

## Open questions
- Residual accepted nit on PR #2070: proxy comment slightly conflates the two bearer-admitted path groups' auth mechanisms (wording only, test-covered) — accepted rather than staling markers for a comment edit.
- Carried: homepage-as-agency-landing confirmation in prod; post-release cron verification; alert #103 CodeQL verification.
