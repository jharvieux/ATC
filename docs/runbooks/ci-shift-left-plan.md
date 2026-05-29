# CI shift-left plan

**Status**: planning doc, not yet executed.
**Author**: 2026-05-28 (during the agent-strategy discussion).
**Goal**: reduce CI wall-time by running deterministic checks locally before push, so CI runs a smaller verification pass on the post-push state.

## Why shift-left

CI is the slowest, most expensive feedback loop. Today every push runs the full check matrix:

```
Typecheck · Lint · Test (full suite + coverage)
Secret Scan · CVE Scan · RLS Snapshot Diff · Cross-Tenant Probe
Contract Tests · Build · Playwright (Tier 1+2+2.5)
```

Most failures (~80% based on recent PR history) are caught by **Typecheck, Lint, Test**, all of which can run locally in seconds-to-minutes. The current `pnpm verify` script + the Stop-hook typecheck (PR #361) already shift some of this left, but the CI re-runs the same checks unconditionally.

Three classes of CI work, ordered by replaceability:

| Class | Examples | Local? | Why |
|---|---|---|---|
| **Reproducible from a clean checkout** | Typecheck, Lint, Test, Build | Yes — already runs locally via `pnpm verify` | Pure functions of the source code |
| **Needs external state** | RLS Snapshot Diff, Contract Tests, CVE Scan | Partly — can run locally if dev env wired | Needs a DB / vendor APIs |
| **Slow-but-must-run** | Playwright Tier 1+2+2.5 | No — heavy + flaky if not isolated | Browser automation has its own infra needs |

## Already shifted

PR #361 landed:
- `pnpm verify` runs typecheck + lint + tests + slop-check
- `pnpm verify:fast` runs typecheck + lint only (sub-30s sanity)
- `.claude/hooks/run-affected-tests.mjs` (Stop hook: runs `vitest related` at turn-end against modified files)
- `scripts/ci-decide-tests.mjs` (Phase 1, see below): CI-side variant that decides full vs affected for PR runs
- Stop hook runs typecheck + affected-tests at end of each turn
- PostToolUse hook lints every Edit/Write
- PreToolUse hook protects MEMORY.md / specs/ from corruption

This means the typical session already passes typecheck + lint + affected tests BEFORE the PR opens. The opportunity is to make CI **trust** this and skip redundant work, OR to **partition** CI so the slow parts only run when something material changed.

## Three orthogonal levers

### Lever 1 — Skip full-suite tests on PRs; run nightly on `dev`

Today CI runs the **full** test suite on every PR. The shift-left version:

- **On PR**: run `scripts/run-affected-tests.mjs <base-ref>`. Tests only files whose imports touch the diff.
- **On a nightly cron against `dev`**: run the full suite. Failures here open an issue or page.
- **On PR with `[full-test]` label**: run full suite (escape hatch when changes are cross-cutting).

**Trade-off**: a test in an unaffected file that depends on broken global state (env, snapshot, schema) won't fail on the PR. The nightly catches it within 24h. Acceptable for this project (single committer, low PR-to-merge frequency).

**Wall-time saved**: ~30-60s per PR average; ~2-3 min on cross-cutting changes (where the affected-test script falls back to full).

**Risk**: low. Affected-tests has been correct in practice; the nightly catches the edge case.

### Lever 2 — Turbo remote cache for `build`

`next build` is the single longest CI step (~2 min on cold cache). If the monorepo is wired to Turbo, you can enable a remote cache:

- Vercel hosts a Turbo cache for free with the Vercel project.
- Cache key includes the file hashes that affect the build output.
- A PR that doesn't touch buildable code hits the cache in seconds.

**Wall-time saved**: ~90s per PR average; near-zero on docs-only changes.

**Risk**: low. Cache is content-addressed; can't return wrong output. Worst case: cache miss falls back to local build.

**Setup**: connect Turbo to the Vercel project, add `TURBO_TOKEN` + `TURBO_TEAM` secrets to GitHub Actions.

### Lever 3 — Playwright sharding + don't run unaffected suites

Playwright runs in `e2e.yml` (separate workflow). If it's a required check today, it's a hidden cost; if it's not, the shift-left here is less urgent.

If Playwright IS required:
- Shard across 4-8 parallel runners (Playwright supports `--shard 1/4` natively).
- Skip Tier 2.5 (the heavy tier) on PRs that don't touch UI; nightly only.
- Trade-off: e2e regressions from a backend-only change land overnight. Acceptable.

**Wall-time saved**: 30-60% of e2e clock-time if it's currently single-shard.

**Risk**: medium. Sharding has its own coordination overhead; some flaky tests hate it.

## Proposed sequencing

Phased so each phase is independently shippable and reversible.

### Phase 1 — Affected-tests on PR (Lever 1)

- Modify `.github/workflows/ci.yml` to use `pnpm test:affected` on PRs.
- Add `.github/workflows/nightly-full-test.yml` against `dev` at 03:00 UTC.
- Add `[full-test]` label handling: if the PR has it, fall back to full suite.
- Verify: open a dummy PR that should only touch a few tests, confirm CI only runs those.

**Effort**: ~4 hours. **Risk**: low.

### Phase 2 — Turbo remote cache (Lever 2)

- Provision Turbo cache via Vercel.
- Add `TURBO_TOKEN` + `TURBO_TEAM` secrets.
- Update CI workflow's `pnpm build` step to use the cache.
- Verify: re-run the same PR's CI twice, confirm second run hits cache.

**Effort**: ~2 hours. **Risk**: low.

### Phase 3 — Playwright sharding (Lever 3)

- Audit current Playwright wall-time + tier breakdown.
- If e2e is currently the bottleneck, shard. If it's not required to merge, deprioritize.
- Stage as needed; don't ship unless Phase 1+2 don't yield enough.

**Effort**: ~6 hours. **Risk**: medium.

### Phase 4 (optional) — Drop redundant `pnpm verify` re-runs from CI

After Phase 1+2 are stable, consider:
- The PR-self-review skill (PR #361) requires me to run `pnpm verify` before pushing.
- CI then re-runs typecheck + lint + (affected) tests.
- If we trust the self-review (and the `## Audit` enforcement workflow confirms it ran), CI can skip the redundant typecheck/lint and just run the harder-to-replicate checks (Secret Scan, CVE Scan, RLS Diff, Cross-Tenant Probe, Contract Tests, Build).

**Trade-off**: trusts a non-deterministic process (me invoking the audit) for deterministic checks. The audit-section enforcement is a forcing function, not a verifier. Probably **not worth the risk** — the savings here are ~30-60s and the failure mode is undetected typecheck regressions in CI.

**Recommendation**: defer Phase 4 indefinitely. Phase 1+2 give the bulk of the speedup.

## Out of scope

- **Replacing CI checks with reviewer judgement.** Already covered in the agent-strategy discussion — reviewers verify intent, CI verifies correctness; they're orthogonal.
- **Cross-tenant probe optimization**. It's already a static probe that runs in <1s. Nothing to shift.
- **Migration linting / RLS snapshot diff**. They depend on the SQL files in the PR; can run locally but the CI version is the source of truth.

## When to revisit

- After §32 self-service help is live and PRs start arriving from Inngest bug-fix paths (Layer 3 in the agent plan). At that point, "run affected tests" needs to handle PRs where the author didn't shift-left, because the author was a bot.
- If CI wall-time exceeds 5 minutes for typical PRs and starts blocking flow.

## Risks not to ignore

- **Affected-tests is a heuristic.** If `scripts/ci-decide-tests.mjs` mis-detects an affected file, a PR can pass CI on a broken codebase. The nightly catches it within ~24h, but a feature merged in the meantime could be built on the regression. Mitigation: ensure the script's "if in doubt, run full suite" fallback is conservative.
- **Turbo cache poisoning.** Theoretically a malicious cache push could ship bad output. Vercel's hosted cache mitigates this (signed, scoped to the team). Self-hosted is riskier.
- **Drift from the deterministic floor.** Each lever we ship is a thing that "used to be checked unconditionally" and is now conditional. The nightly is the safety net. If it stops running or stops paging, regressions accumulate silently.

## Decision needed before Phase 1

- [ ] Confirm `scripts/ci-decide-tests.mjs` is reliable enough on this codebase (sample 20 PRs, check it caught the right tests).
- [ ] Confirm nightly failure notifications go somewhere (Slack / email / GitHub issue?).
- [ ] Confirm `[full-test]` label exists or create it.
