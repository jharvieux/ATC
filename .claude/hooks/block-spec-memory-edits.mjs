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
// Carve-out (#1661): an Edit that does nothing but renumber a `## D-NNN`
// header — and every other `D-NNN` mention inside the same edit — is allowed
// IF that number does not exist in MEMORY.md on origin/dev (i.e. the entry is
// branch-local, not merged history). This exists because two concurrent
// branches can independently compute the same "next" D-number (the #1652 vs
// #1643 D-318 collision); the CI guard (check:memory-decision-collision)
// catches it, but the append-only rule as written left no way for an agent to
// fix its OWN not-yet-merged entry — Edit is rejected because a renumber
// isn't a pure prepend. This does NOT weaken the rule for any entry that
// exists on origin/dev: that check requires a `git show` against the remote
// ref, and any failure to resolve it (git error, no network, ref not fetched)
// falls through to the original block — ambiguity still fails closed.
//
// Exit codes:
//   0 — allow
//   2 — block (stderr surfaced back to the main agent)

import { readFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";

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

// Returns true only for an Edit that (a) changes exactly one D-number,
// consistently, everywhere it appears in old_string, to exactly one other
// D-number, with NOTHING else different between old_string and new_string,
// and (b) that old D-number does not exist in MEMORY.md on origin/dev. Any
// ambiguity (git failure, more than one distinct number touched, a
// non-numeric diff) returns false — the original prepend-only block still
// applies.
function isAllowedBranchLocalRenumber(oldString, newString) {
  const oldNums = [...new Set([...oldString.matchAll(/D-(\d+)/g)].map((m) => m[1]))];
  const newNums = [...new Set([...newString.matchAll(/D-(\d+)/g)].map((m) => m[1]))];
  if (oldNums.length !== 1 || newNums.length !== 1) return false;

  const [oldNum] = oldNums;
  const [newNum] = newNums;
  if (oldNum === newNum) return false;

  const expected = oldString.replaceAll(`D-${oldNum}`, `D-${newNum}`);
  if (expected !== newString) return false;

  let baseMemory;
  try {
    baseMemory = execFileSync("git", ["show", "origin/dev:MEMORY.md"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return false; // can't confirm the entry is branch-local — fail closed
  }
  const headerRe = (n) => new RegExp(`^## D-${n}\\b`, "m");
  if (headerRe(oldNum).test(baseMemory)) return false; // merged history — stays blocked

  // The header check above only rules out old_string touching a MERGED
  // entry's header. A legitimate branch-local renumber only ever targets
  // text this branch itself added, which by definition can't already be
  // sitting in origin/dev's file — so if old_string appears there verbatim,
  // this edit would be rewriting a D-number token inside an already-merged
  // entry's BODY (a case the header-only check doesn't see). Block it.
  if (baseMemory.includes(oldString)) return false;

  return true;
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
    if (!newString.endsWith(oldString) && !isAllowedBranchLocalRenumber(oldString, newString)) {
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
