# Mutation testing (Stryker)

Mutation testing measures whether our **tests** would catch a bug, not just whether code runs. Stryker mutates source (flips `>=`→`>`, deletes statements, swaps string literals, etc.) and re-runs the vitest suite; a mutant that no test catches = "survived" = a gap in test assertions.

## Configs

- **`stryker.config.json`** (`pnpm mutate`) — broad scan, `coverageAnalysis: perTest`, `ignoreStatic: true`. Fast. Use for a whole-codebase pass or `--mutate`-scoped runs.
- **`stryker.thorough.config.json`** (`pnpm mutate:thorough`) — `coverageAnalysis: all`, `ignoreStatic: false`. Slower; **accurate for module-load constants** (grant-key Sets, code maps).
- **`vitest.stryker.config.ts`** — the vitest config both Stryker configs use. Identical to `vitest.config.ts` except it excludes source-introspection meta-tests that regex-parse app source (Stryker's mutant brackets break their parse). Those tests still run in normal CI.

## Running

```bash
# Whole codebase (slow — minutes to ~hours depending on concurrency)
pnpm mutate

# Scoped to a domain (preferred per-PR; the config comment says re-scope via --mutate)
pnpm mutate --mutate "apps/main/src/lib/auth/**/*.ts"

# Accurate re-measure of module-load-constant files
pnpm mutate:thorough --mutate "apps/main/src/lib/auth/permission-grants.ts"

# Raise concurrency on a multi-core box (default committed value is 2 for CI memory safety)
pnpm mutate --concurrency 6
```

Reports land in `reports/mutation/` (`mutation.html`, `mutation.json`).

## Reading the results — three traps

1. **`perTest` under-measures module-load constants.** A file built around `Set`/`Map` literals evaluated at import (e.g. `lib/auth/permission-grants.ts`) can show a wildly low score under `perTest` that is a *measurement artifact*, not a gap. permission-grants.ts measured **6% under perTest vs 83% under thorough**. Always re-measure such files with `pnpm mutate:thorough` before concluding they're untested.
2. **vitest-only.** Stryker only observes the vitest suite. Routes/flows covered by **Playwright E2E** have coverage Stryker can't see, so `NoCoverage` ≠ "untested in CI" for those. The value of closing a vitest gap is unit-level boundary/branch/permission coverage E2E doesn't provide.
3. **RAG needs its own pass.** The broad config mutates `apps/rag/src/**` but runs the **root** vitest config, which excludes `apps/rag/test/**` (RAG is tested via `pnpm test:rag` / `apps/rag/vitest.config.ts`). So RAG mutants all show false `NoCoverage` in the broad sweep. A dedicated RAG Stryker config is tracked separately.

## Sandbox notes

Stryker copies the project into `.stryker-tmp/sandbox-*`. `ignorePatterns` in both configs keeps `.claude` (Claude Code worktrees + the `skills/patch` symlink, which crashes the copy with `ENOTSUP`) and build dirs out of that copy. `ignorePatterns` affects only the sandbox copy, never the mutate set.

## History

The first full-codebase baseline (2026-06-17) scored **27.85%** overall (58% on covered code). See decision log D-260 and the mutation-roadmap epic for the gap issues it produced.
