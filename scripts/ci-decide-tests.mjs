#!/usr/bin/env node
// Phase 1 shift-left: decide whether CI's Test job runs the full vitest
// suite or only tests affected by the PR diff.
//
// Inputs:
//   - $GITHUB_BASE_REF — the PR's base branch (e.g. "dev")
//   - $LABELS — comma-separated list of labels on the PR
//
// Decision logic (any rule triggers full suite):
//   - PR carries the "full-test" label
//   - The diff vs base is empty (defensive)
//   - The diff touches a config file (vite/vitest/tsconfig/eslint/package.json)
//   - The diff touches a "deep utility" path (db/, auth/, ai/call-wrapper.ts,
//     env.ts) — these are imported transitively by hundreds of files and the
//     affected-tests graph misses indirect impacts
//   - The diff includes 50+ source files (likely a refactor)
//
// Output to stdout (consumed by the workflow's $GITHUB_OUTPUT):
//   mode=full
//   reason=<one-line explanation>
//
// OR:
//
//   mode=affected
//   reason=affected by N source file(s)
//   files=path1 path2 ...     # space-separated, ready to splat into `vitest related`

import { execSync } from "node:child_process";
import { isCiPathSafe } from "./lib/ci-path-safe.mjs";

const BASE_REF = process.env.GITHUB_BASE_REF || "dev";
const LABELS = (process.env.LABELS || "").split(",").map((s) => s.trim()).filter(Boolean);

const FULL_TEST_LABEL = "full-test";

// Path patterns that force full suite when changed. Two reasons to be on this list:
//   (1) Imported transitively by everything (db, auth, env).
//   (2) Their behavior changes cross-cutting test expectations (vitest config).
const DEEP_UTILITY_PATTERNS = [
  /^apps\/main\/src\/lib\/db\//,
  /^apps\/main\/src\/lib\/auth\//,
  /^apps\/main\/src\/lib\/env\.ts$/,
  /^apps\/main\/src\/lib\/ai\/call-wrapper\.ts$/,
  /^apps\/main\/src\/lib\/ai\/stream-wrapper\.ts$/,
  /^apps\/main\/src\/lib\/supervisor\//,
];

const CONFIG_PATTERNS = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /\/package\.json$/,
  /vite\.config\.[tj]s$/,
  /vitest\.config\.[tj]s$/,
  /tsconfig.*\.json$/,
  /eslint\.config\.[tj]s$/,
  /\.eslintrc/,
];

const REFACTOR_FILE_THRESHOLD = 50;

function emit(mode, reason, files = "") {
  // GitHub Actions $GITHUB_OUTPUT parses one `key=value` per line; multi-line
  // values break the parser. Collapse whitespace + cap length so any error
  // detail (e.g. git stderr) stays on one line.
  const safeReason = String(reason).replace(/\s+/g, " ").trim().slice(0, 200);
  console.log(`mode=${mode}`);
  console.log(`reason=${safeReason}`);
  if (files) console.log(`files=${files}`);
}

function fail(reason) {
  emit("full", `defensive: ${reason}`);
  process.exit(0);
}

if (LABELS.includes(FULL_TEST_LABEL)) {
  emit("full", `'${FULL_TEST_LABEL}' label present`);
  process.exit(0);
}

let changed;
try {
  // The PR base ref is fetched by the workflow's checkout step. Use the
  // remote ref so we don't depend on a local branch existing.
  changed = execSync(`git diff --name-only origin/${BASE_REF}...HEAD`, {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
} catch (err) {
  fail(`git diff failed: ${err.message}`);
}

if (changed.length === 0) {
  fail("empty diff");
}

// CI shell-injection guard (#571): changed paths flow into the workflow's
// echoed `reason` and the `vitest related` args, so a crafted filename outside
// the safe charset forces the full suite (fail-closed) rather than reaching the
// shell. Allowlist + rationale live in scripts/lib/ci-path-safe.mjs; the
// fallback reason deliberately omits the offending path.
if (changed.some((f) => !isCiPathSafe(f))) {
  fail("changed path contains unexpected characters");
}

const configHits = changed.filter((f) => CONFIG_PATTERNS.some((re) => re.test(f)));
if (configHits.length > 0) {
  emit("full", `config files changed: ${configHits.slice(0, 3).join(", ")}${configHits.length > 3 ? "..." : ""}`);
  process.exit(0);
}

const deepHits = changed.filter((f) => DEEP_UTILITY_PATTERNS.some((re) => re.test(f)));
if (deepHits.length > 0) {
  emit("full", `deep utility changed: ${deepHits.slice(0, 3).join(", ")}${deepHits.length > 3 ? "..." : ""}`);
  process.exit(0);
}

if (changed.length >= REFACTOR_FILE_THRESHOLD) {
  emit("full", `${changed.length} files changed (>= ${REFACTOR_FILE_THRESHOLD} refactor threshold)`);
  process.exit(0);
}

// Filter to file types vitest cares about. Same set as the Stop hook script.
const TESTABLE_EXT = /\.(tsx?|jsx?|md)$/;
const candidates = changed.filter((f) => TESTABLE_EXT.test(f));

if (candidates.length === 0) {
  fail("no testable files in diff (defensive)");
}

// Vitest's `related` subcommand accepts source files; it computes the
// affected test files from its dependency graph.
// Single-quote each path so paths with shell-special chars like
// `(tenant)` (Next.js route groups) survive bash splat in the workflow.
emit(
  "affected",
  `affected by ${candidates.length} source file(s)`,
  candidates.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(" "),
);
