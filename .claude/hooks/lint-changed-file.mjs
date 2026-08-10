#!/usr/bin/env node
// PostToolUse hook: lints the touched TS/TSX file in apps/main or apps/rag
// so lint errors surface in-loop instead of at CI. Exit 2 sends stderr
// back to the main agent; the edit itself has already happened by the
// time PostToolUse runs (no rollback).
//
// Skips:
//   - non-TS/TSX paths
//   - files outside apps/main and apps/rag (e.g. packages/*, scripts/*)
//   - test directories (workspace excludes them from lint)
//   - generated output (.next, dist, .turbo, node_modules)
//
// Wired in .claude/settings.json under hooks.PostToolUse, matcher
// "Edit|Write". See docs/runbooks/claude-code-setup.md for setup.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, relative } from "node:path";
import { editTargetPaths } from "./edit-targets.mjs";

let input;
try {
  input = JSON.parse(readFileSync(0, "utf-8"));
} catch (error) {
  process.stderr.write(`Could not parse hook input (PostToolUse hook): ${error.message}\n`);
  process.exit(2);
}

const { tool_name } = input || {};
const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
if (!["Edit", "Write", "apply_patch"].includes(tool_name)) process.exit(0);

let filePaths;
try {
  filePaths = editTargetPaths(input);
} catch (error) {
  process.stderr.write(`Could not parse edited paths (PostToolUse hook): ${error.message}\n`);
  process.exit(2);
}

const workspaceFiles = new Map();
for (const filePath of new Set(filePaths)) {
  if (!/\.tsx?$/.test(filePath)) continue;
  const abs = resolve(REPO_ROOT, filePath);
  if (!existsSync(abs)) continue;
  const rel = relative(REPO_ROOT, abs);

  if (
    rel.includes("node_modules") ||
    rel.includes(".next/") ||
    rel.includes("/dist/") ||
    rel.includes(".turbo/") ||
    rel.includes("coverage/")
  ) {
    continue;
  }

  if (rel.startsWith("apps/main/test/") || rel.startsWith("apps/rag/test/")) continue;

  let workspace;
  if (rel.startsWith("apps/main/")) workspace = "@atc/main";
  else if (rel.startsWith("apps/rag/")) workspace = "@atc/rag";
  else continue;
  const files = workspaceFiles.get(workspace) ?? [];
  files.push({ abs, rel });
  workspaceFiles.set(workspace, files);
}

const failures = [];
for (const [workspace, files] of workspaceFiles) {
  const result = spawnSync(
    "pnpm",
    [
      "--silent",
      "--filter",
      workspace,
      "exec",
      "eslint",
      "--max-warnings=0",
      "--no-warn-ignored",
      ...files.map(({ abs }) => abs),
    ],
    { cwd: REPO_ROOT, encoding: "utf-8", timeout: 30_000 },
  );

  if (result.status === 0) continue;

  const output = (result.stdout || "").trim() || (result.stderr || "").trim();
  failures.push(
    result.error || result.signal
      ? `Lint could not run for ${workspace}: ${result.error?.message ?? result.signal}`
      : `Lint failed on ${files.map(({ rel }) => rel).join(", ")} (PostToolUse hook).\n${output || "(no output)"}`,
  );
}

if (failures.length === 0) process.exit(0);

process.stderr.write(
  `${failures.join("\n\n")}\n\nFix these before continuing — the edit landed but CI will reject it.\n`,
);
process.exit(2);
