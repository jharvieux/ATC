#!/usr/bin/env node
// PreToolUse hook: protects the two CLAUDE.md rules that are most
// expensive when Claude violates them:
//
//   1. specs/** is read-only source of truth — no edits ever.
//   2. MEMORY.md prior entries are read-only history — only prepends/additions.
//
// Wired in .claude/settings.json under hooks.PreToolUse, matcher
// "Edit|Write|NotebookEdit". Fails closed: any parse/read error blocks
// the tool call.
//
// Exit codes:
//   0 — allow
//   2 — block (stderr surfaced back to the main agent)

import { readFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function block(reason) {
  process.stderr.write(reason + "\n");
  process.exit(2);
}

let input;
try {
  input = JSON.parse(readFileSync(0, "utf-8"));
} catch (e) {
  block(`BLOCKED: hook could not parse stdin JSON (${e.message}). Fail-closed per CLAUDE.md.`);
}

const { tool_name, tool_input } = input || {};

if (!["Edit", "Write", "NotebookEdit"].includes(tool_name)) {
  process.exit(0);
}

const filePath = tool_input?.file_path || tool_input?.notebook_path;
if (!filePath || typeof filePath !== "string") {
  process.exit(0);
}

const abs = resolve(filePath);
const rel = relative(REPO_ROOT, abs);

if (rel === "specs" || rel.startsWith("specs/")) {
  block(
    `BLOCKED: ${tool_name} on ${rel}\n` +
      `specs/ is the read-only source of truth per CLAUDE.md. If the spec is wrong, ` +
      `surface the conflict to the user and ask for explicit permission before editing.`
  );
}

const MEMORY_PATH = resolve(REPO_ROOT, "MEMORY.md");
if (abs === MEMORY_PATH) {
  if (!existsSync(MEMORY_PATH)) process.exit(0);

  let currentContent;
  try {
    currentContent = readFileSync(MEMORY_PATH, "utf-8");
  } catch (e) {
    block(`BLOCKED: could not read MEMORY.md (${e.message}). Fail-closed.`);
  }

  if (tool_name === "Edit") {
    const oldString = tool_input?.old_string || "";
    const newString = tool_input?.new_string || "";
    if (!newString.endsWith(oldString)) {
      block(
        `BLOCKED: Edit on MEMORY.md modifies a prior entry.\n` +
          `Per CLAUDE.md, prior MEMORY.md entries are read-only history — only prepends allowed.\n` +
          `If you genuinely need to edit a prior entry, ask the user for explicit permission first.`
      );
    }
  } else if (tool_name === "Write") {
    const newContent = tool_input?.content || "";
    const newTrim = newContent.replace(/\s+$/, "");
    const curTrim = currentContent.replace(/\s+$/, "");
    if (!newTrim.endsWith(curTrim)) {
      block(
        `BLOCKED: Write on MEMORY.md doesn't preserve existing entries.\n` +
          `Per CLAUDE.md, prior MEMORY.md entries are read-only history — only prepends allowed.\n` +
          `The new content must end with the existing file content verbatim.`
      );
    }
  }
}

process.exit(0);
