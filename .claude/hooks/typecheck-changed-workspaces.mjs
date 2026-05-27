#!/usr/bin/env node
// Stop hook: typecheck workspaces with uncommitted TS/TSX changes when
// Claude's turn ends.
//
// Why a Stop hook (not PostToolUse): tsc -noEmit takes ~45s for a full
// workspace; running it per-edit would kill the dev loop. Once at
// turn-end is acceptable friction and catches the "next category up"
// from the per-edit lint hook (lint catches style/unused/hooks rules;
// typecheck catches type drift, missing exports, bad import paths).
//
// Behavior:
//   - Reads `git status --porcelain` to find modified/added TS files.
//   - If apps/main has any changed TS files → `pnpm --filter @atc/main typecheck`.
//   - If apps/rag has any changed TS files → `pnpm --filter @atc/rag typecheck`.
//   - If neither → exits 0 silently (most turns).
//   - On failure → exit 2 with the tsc output as stderr. Claude Code
//     surfaces the stderr to the agent as a system reminder, prompting
//     the next turn to address the type error.
//
// Worst case: one extra turn after the user asked Claude to stop, where
// Claude attempts to fix a type error. If it can't fix (pre-existing,
// unrelated, etc.), it surfaces to the user.
//
// Wired in .claude/settings.json under hooks.Stop. See
// docs/runbooks/claude-code-setup.md.

import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

try { readFileSync(0, "utf-8"); } catch {}

function changedTsFiles() {
  try {
    const raw = execSync(
      "git status --porcelain --untracked-files=normal",
      { cwd: REPO_ROOT, encoding: "utf-8" }
    );
    return raw
      .split("\n")
      .map(line => line.replace(/^...\s*/, "").trim())
      .filter(path => /\.tsx?$/.test(path));
  } catch {
    return [];
  }
}

const files = changedTsFiles();
const mainChanged = files.some(p => p.startsWith("apps/main/"));
const ragChanged = files.some(p => p.startsWith("apps/rag/"));

if (!mainChanged && !ragChanged) process.exit(0);

const workspaces = [];
if (mainChanged) workspaces.push("@atc/main");
if (ragChanged) workspaces.push("@atc/rag");

const failures = [];
for (const ws of workspaces) {
  const result = spawnSync(
    "pnpm",
    ["--silent", "--filter", ws, "exec", "tsc", "--noEmit"],
    { cwd: REPO_ROOT, encoding: "utf-8", timeout: 180_000 }
  );

  if (result.error || result.signal) continue;

  if (result.status !== 0) {
    failures.push({
      workspace: ws,
      output: (result.stdout || "").trim() || (result.stderr || "").trim(),
    });
  }
}

if (failures.length === 0) process.exit(0);

let msg = "Typecheck failed at turn-end (Stop hook):\n\n";
for (const { workspace, output } of failures) {
  msg += `── ${workspace} ──\n${output || "(no output)"}\n\n`;
}
msg += "Fix the type error(s) before continuing. If unfixable in this context, surface to the user.\n";
process.stderr.write(msg);
process.exit(2);
