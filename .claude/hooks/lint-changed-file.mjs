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

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, relative } from "node:path";

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

let input;
try {
  input = JSON.parse(readFileSync(0, "utf-8"));
} catch {
  process.exit(0);
}

const { tool_name, tool_input } = input || {};
if (!["Edit", "Write"].includes(tool_name)) process.exit(0);

const filePath = tool_input?.file_path;
if (!filePath || typeof filePath !== "string") process.exit(0);
if (!/\.tsx?$/.test(filePath)) process.exit(0);

const abs = resolve(filePath);
const rel = relative(REPO_ROOT, abs);

if (
  rel.includes("node_modules") ||
  rel.includes(".next/") ||
  rel.includes("/dist/") ||
  rel.includes(".turbo/") ||
  rel.includes("coverage/")
) {
  process.exit(0);
}

if (rel.startsWith("apps/main/test/") || rel.startsWith("apps/rag/test/")) {
  process.exit(0);
}

let workspace;
if (rel.startsWith("apps/main/")) workspace = "@atc/main";
else if (rel.startsWith("apps/rag/")) workspace = "@atc/rag";
else process.exit(0);

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
    abs,
  ],
  { cwd: REPO_ROOT, encoding: "utf-8", timeout: 30_000 }
);

if (result.status === 0) {
  process.exit(0);
}

if (result.error || result.signal) {
  process.exit(0);
}

const stdout = (result.stdout || "").trim();
const stderr = (result.stderr || "").trim();

process.stderr.write(
  `Lint failed on ${rel} (PostToolUse hook).\n` +
    `${stdout || stderr || "(no output)"}\n` +
    `\nFix these before continuing — the edit landed but CI will reject it.\n`
);
process.exit(2);
