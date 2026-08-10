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
import { parseApplyPatch } from "./edit-targets.mjs";

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
const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

if (!["Edit", "Write", "NotebookEdit", "apply_patch"].includes(tool_name)) {
  process.exit(0);
}

function repoPath(filePath) {
  const abs = resolve(REPO_ROOT, filePath);
  return { abs, rel: relative(REPO_ROOT, abs) };
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
function protectMemoryEdit(abs, editToolName, editInput) {
  if (abs !== MEMORY_PATH) return;
  if (!existsSync(MEMORY_PATH)) process.exit(0);

  let currentContent;
  try {
    currentContent = readFileSync(MEMORY_PATH, "utf-8");
  } catch (e) {
    block(`BLOCKED: could not read MEMORY.md (${e.message}). Fail-closed.`);
  }

  if (editToolName === "Edit") {
    const oldString = editInput?.old_string || "";
    const newString = editInput?.new_string || "";
    if (!newString.endsWith(oldString) && !isAllowedBranchLocalRenumber(oldString, newString)) {
      block(
        `BLOCKED: Edit on MEMORY.md modifies a prior entry.\n` +
          `Per CLAUDE.md, prior MEMORY.md entries are read-only history — only prepends allowed.\n` +
          `If you genuinely need to edit a prior entry, ask the user for explicit permission first.`
      );
    }
  } else if (editToolName === "Write") {
    const newContent = editInput?.content || "";
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

function isAllowedMemoryPatch(section) {
  if (section.operation !== "Update" || section.moveTo) return false;
  const hunks = [];
  let current;
  for (const line of section.lines) {
    if (line.startsWith("@@")) {
      current = [];
      hunks.push(current);
    } else if (line !== "*** End of File") {
      if (!current) return false;
      current.push(line);
    }
  }
  if (hunks.length !== 1) return false;

  const hunk = hunks[0];
  if (hunk.some((line) => !line || !["+", "-", " "].includes(line[0]))) return false;
  const deleted = hunk.filter((line) => line.startsWith("-")).map((line) => line.slice(1));
  const added = hunk.filter((line) => line.startsWith("+")).map((line) => line.slice(1));
  if (deleted.length > 0) {
    return added.length > 0 && isAllowedBranchLocalRenumber(deleted.join("\n"), added.join("\n"));
  }
  if (added.length === 0) return false;

  const firstContext = hunk.findIndex((line) => line.startsWith(" "));
  if (firstContext < 0 || hunk.slice(firstContext).some((line) => !line.startsWith(" "))) return false;
  const context = hunk
    .slice(firstContext)
    .map((line) => line.slice(1))
    .join("\n");
  let currentContent;
  try {
    currentContent = readFileSync(MEMORY_PATH, "utf8");
  } catch (error) {
    block(`BLOCKED: could not read MEMORY.md (${error.message}). Fail-closed.`);
  }
  return currentContent.startsWith(context);
}

if (tool_name === "apply_patch") {
  let sections;
  try {
    sections = parseApplyPatch(tool_input?.command);
  } catch (error) {
    block(`BLOCKED: malformed apply_patch input (${error.message}). Fail-closed per AGENTS.md.`);
  }
  for (const section of sections) {
    const targets = section.moveTo ? [section.path, section.moveTo] : [section.path];
    for (const target of targets) {
      const { rel } = repoPath(target);
      if (rel === "specs" || rel.startsWith("specs/")) {
        block(`BLOCKED: apply_patch on ${rel}\nspecs/ is the read-only source of truth per AGENTS.md.`);
      }
    }
    const touchesMemory = targets.some((target) => repoPath(target).abs === MEMORY_PATH);
    if (touchesMemory && !isAllowedMemoryPatch(section)) {
      block(
        `BLOCKED: apply_patch on MEMORY.md modifies prior history.\n` +
          `Per AGENTS.md, prior MEMORY.md entries are read-only — only prepends or branch-local renumbers are allowed.`,
      );
    }
  }
  process.exit(0);
}

const filePath = tool_input?.file_path || tool_input?.notebook_path;
if (!filePath || typeof filePath !== "string") process.exit(0);
const { abs, rel } = repoPath(filePath);
if (rel === "specs" || rel.startsWith("specs/")) {
  block(
    `BLOCKED: ${tool_name} on ${rel}\n` +
      `specs/ is the read-only source of truth per CLAUDE.md. If the spec is wrong, ` +
      `surface the conflict to the user and ask for explicit permission before editing.`,
  );
}
protectMemoryEdit(abs, tool_name, tool_input);

process.exit(0);
