#!/usr/bin/env node
// Stop hook: run vitest with --related on changed files at turn-end.
//
// Why: lint catches style; typecheck catches types; this catches the
// "your behavior change broke a test that imports your file" class —
// the one that bit #345 (rewriting a content file invalidated an
// assertion in docs-loader.test.ts that scanned that content).
//
// vitest --related <files> figures out which test files transitively
// import each changed file and runs only those. Fast (seconds) unless
// the changed file is a deep utility imported everywhere.
//
// Behavior:
//   - Reads `git status --porcelain` to find modified/added files.
//   - Filters to extensions vitest cares about (.ts/.tsx/.js/.jsx/.md
//     — markdown counts because docs-loader-style tests scan content
//     dirs and "related" can include those).
//   - If no candidate files → exit 0.
//   - Runs `pnpm vitest run --related <files>` from repo root.
//   - On failure → exit 2 with output. Claude surfaces to the agent.
//
// Why a Stop hook (not PostToolUse): running tests on every edit would
// kill the dev loop. Once at turn-end is the right cadence — same as
// the typecheck hook.

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

try { readFileSync(0, "utf-8"); } catch {}

// Skip if no vitest available (e.g., pnpm not installed in this env).
if (!existsSync(join(REPO_ROOT, "node_modules", ".bin", "vitest"))) {
  process.exit(0);
}

function changedCandidateFiles() {
  try {
    const raw = execSync(
      "git status --porcelain --untracked-files=normal",
      { cwd: REPO_ROOT, encoding: "utf-8" },
    );
    return raw
      .split("\n")
      .map((line) => line.replace(/^...\s*/, "").trim())
      .filter((p) => p && /\.(tsx?|jsx?|md)$/.test(p))
      // Skip test files themselves — running tests against changed
      // test files is the regular flow, not what --related is for.
      .filter((p) => !/\.test\.[tj]sx?$/.test(p))
      // Skip generated output + deps.
      .filter((p) => !p.startsWith("node_modules/"))
      .filter((p) => !p.startsWith("apps/main/.next/"))
      .filter((p) => !p.includes("/dist/"))
      .filter((p) => !p.includes("/.turbo/"));
  } catch {
    return [];
  }
}

const files = changedCandidateFiles();
if (files.length === 0) process.exit(0);

// Cap the file list to avoid blowing past argv limits on huge changes.
const MAX_FILES = 50;
const fileArgs = files.slice(0, MAX_FILES);

// Vitest CLI: `vitest related <files>` is the sub-command form (run-once
// by default). NOT `vitest run --related <files>` — that flag doesn't
// exist in vitest 4.x.
const result = spawnSync(
  "pnpm",
  ["--silent", "vitest", "related", ...fileArgs],
  {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 180_000,
    // Force CI-mode env so vitest doesn't enter watch mode on a TTY.
    env: { ...process.env, CI: "1" },
  },
);

if (result.error || result.signal) process.exit(0);

if (result.status === 0) process.exit(0);

// Vitest exits non-zero ONLY on real failures (not on "no tests matched")
// per its docs. So a non-zero here means a related test failed.
let msg = "Affected tests failed at turn-end (Stop hook, vitest --related):\n\n";
const stdout = (result.stdout || "").trim();
const stderr = (result.stderr || "").trim();
msg += stdout || stderr || "(no output)";
msg += "\n\nFix the failing test(s) before continuing. If the test was already broken on dev (pre-existing), say so to the user and don't block on it.\n";
process.stderr.write(msg);
process.exit(2);
