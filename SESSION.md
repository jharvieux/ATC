# Session state — last updated 2026-06-17 (Stryker mutation sweep + triage complete)

## Just completed

- **Full-codebase Stryker mutation sweep** (broad `stryker.config.json`, 679 files / 52,152 mutants, concurrency 6, ~15 min). **Overall 27.85%** (58% covered-only; 26,488 NoCoverage dominates). Reports: `reports/mutation/mutation.html`, `reports/mutation/mutation.broad-full.json` (canonical; `mutation.json` restored to match).
- **Fixed 3 Stryker tooling bugs** (uncommitted on `dev`, see below): sandbox-copy ENOTSUP crash on `.claude` symlink → `ignorePatterns`; baseline dry-run abort on the onboarding-grants introspection meta-test → new `vitest.stryker.config.ts`; broken `mutate:thorough` script (`--configFile` → positional).
- **Confirmed perTest measurement artifact**: `permission-grants.ts` 6%→**83%** under `thorough`; `tier-codes.ts` 19%→88%. Did NOT misreport these as gaps.
- **Filed triage to GitHub**: epic **#1219** + domain issues **#1211–#1218** + data comment on **#1204** (cron auth gates). See D-260.

## In flight

- **4 uncommitted files on `dev`** (additive tooling fixes, repo not broken): `stryker.config.json`, `stryker.thorough.config.json`, `vitest.stryker.config.ts` (new), `package.json` (mutate:thorough one-liner). MEMORY.md (D-260) + this SESSION.md also pending commit.
- These need a PR into `dev` (never commit directly). Not yet branched.

## Next step

- **Open the Stryker-tooling PR**: branch `feature/stryker-sweep-fixes` off `dev` → `pnpm verify` → push → `gh pr create` with `## Audit` placeholder → run `d091-reviewer` + `pre-pr-reviewer` (diff is small: 3 config/json + 1 new ~25-line vitest config + a package.json one-liner → Sonnet is fine, no Opus trigger) → fill Audit block → merge when CI green. Consider adding a short `docs/testing/mutation-testing.md` runbook (how to run broad vs thorough, the perTest/RAG caveats) to the same PR.
- Then the test-writing work itself is tracked across #1211–#1218 (not started; separate PRs, security/money first).

## Blocked on user

- Awaiting go-ahead to open the tooling PR now vs. defer (offered at end of session). Everything else is done.

## Open questions

- #1218: RAG needs its own Stryker pass (`stryker.rag.config.json` pointing at `apps/rag/vitest.config.ts`) — do as part of the tooling PR or separately? Currently proposed as separate follow-up in the issue.
- Pre-existing (prior session): `check:duplication` ~6% (non-gating); cross-tenant-rls-bypass-monitor fail-open read (#1205 to file).
