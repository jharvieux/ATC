// Tests for the MEMORY.md append-only PreToolUse hook, focused on the #1661
// branch-local-renumber carve-out.
//
// The hook is a standalone .mjs script (no exports — it reads stdin and calls
// process.exit), so it's exercised the same way Claude Code actually invokes
// it: as a subprocess fed the tool_input JSON on stdin, asserting on exit code.
//
// Intent: an Edit that renumbers a D-NNN header (and matching in-body
// mentions) must be ALLOWED when that number is branch-local (absent from
// origin/dev's MEMORY.md) — that's the whole point of the carve-out, since
// two concurrent branches can independently claim the same number and the
// loser needs a way to fix its own not-yet-merged entry. It must stay BLOCKED
// when the number already exists in merged history (origin/dev), or when the
// edit changes anything beyond a consistent single-number substitution — the
// carve-out must not become a general-purpose "edit MEMORY.md" bypass.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HOOK_PATH = path.join(REPO_ROOT, ".claude/hooks/block-spec-memory-edits.mjs");

function runHook(toolInput: Record<string, unknown>): { code: number | null; stderr: string } {
  const result = spawnSync("node", [HOOK_PATH], {
    input: JSON.stringify({ tool_name: "Edit", tool_input: toolInput }),
    encoding: "utf-8",
    cwd: REPO_ROOT,
  });
  return { code: result.status, stderr: result.stderr };
}

function runCodexPatch(command?: string): { code: number | null; stderr: string } {
  const result = spawnSync("node", [HOOK_PATH], {
    input: JSON.stringify({
      cwd: REPO_ROOT,
      tool_name: "apply_patch",
      tool_input: command === undefined ? {} : { command },
    }),
    encoding: "utf-8",
    cwd: REPO_ROOT,
  });
  return { code: result.status, stderr: result.stderr };
}

// A number guaranteed absent from origin/dev's MEMORY.md at any point in this
// repo's history (real entries are far below this).
const BRANCH_LOCAL_A = "999999";
const BRANCH_LOCAL_B = "999998";

describe("block-spec-memory-edits.mjs — branch-local renumber carve-out (#1661)", () => {
  it("allows renumbering a branch-local-only D-number consistently across header + body", () => {
    const { code } = runHook({
      file_path: "MEMORY.md",
      old_string: `## D-${BRANCH_LOCAL_A} — 2026-07-07 — Test entry\n\nBody mentioning D-${BRANCH_LOCAL_A} again.`,
      new_string: `## D-${BRANCH_LOCAL_B} — 2026-07-07 — Test entry\n\nBody mentioning D-${BRANCH_LOCAL_B} again.`,
    });
    expect(code).toBe(0);
  });

  it("blocks renumbering a D-number that exists in origin/dev's merged history", () => {
    // D-319 is a real, merged entry as of this writing — see MEMORY.md.
    const { code, stderr } = runHook({
      file_path: "MEMORY.md",
      old_string: "## D-319 — 2026-07-07 — Money-formatter consolidation redone clean (#1638 → #1657); fromCents brand-type kept narrow",
      new_string: "## D-320 — 2026-07-07 — Money-formatter consolidation redone clean (#1638 → #1657); fromCents brand-type kept narrow",
    });
    expect(code).toBe(2);
    expect(stderr).toContain("BLOCKED");
  });

  it("still allows an ordinary prepend (new_string ends with old_string)", () => {
    const { code } = runHook({
      file_path: "MEMORY.md",
      old_string: "## D-319 — 2026-07-07 — Money-formatter consolidation redone clean (#1638 → #1657); fromCents brand-type kept narrow",
      new_string:
        "## D-320 — 2026-07-08 — New entry\n\nbody\n\n---\n\n## D-319 — 2026-07-07 — Money-formatter consolidation redone clean (#1638 → #1657); fromCents brand-type kept narrow",
    });
    expect(code).toBe(0);
  });

  it("blocks a renumber that also changes unrelated content (not a pure substitution)", () => {
    const { code } = runHook({
      file_path: "MEMORY.md",
      old_string: `## D-${BRANCH_LOCAL_A} — 2026-07-07 — Test entry\n\nBody mentioning D-${BRANCH_LOCAL_A} again.`,
      new_string: `## D-${BRANCH_LOCAL_B} — 2026-07-07 — DIFFERENT TITLE\n\nBody mentioning D-${BRANCH_LOCAL_B} again, plus extra text.`,
    });
    expect(code).toBe(2);
  });

  it("blocks a D-number substitution whose old_string is verbatim text from a MERGED entry's BODY, when that number has NO header of its own", () => {
    // D-088 is a real inline mention inside another entry's body on
    // origin/dev's MEMORY.md ("...DIY CruiseMapper scraper (D-088 Apify-2)
    // into `general_pricing_ranges`...") — but D-088 has NO "## D-088" header
    // anywhere in the file (it's an old reference-only mention, not its own
    // entry). This is the case that actually distinguishes the body-overlap
    // check from the pre-existing header check: the header check alone
    // (`headerRe(oldNum).test(baseMemory)`) would NOT catch this, because
    // there is no "## D-088" header to match against — only the new
    // `baseMemory.includes(oldString)` check blocks it. (A D-304 substitution
    // was tried first here but D-304 has its own merged header, so the
    // pre-existing header check alone already blocked it — that didn't
    // actually exercise the new line. This case does.)
    const { code } = runHook({
      file_path: "MEMORY.md",
      old_string: "the DIY CruiseMapper scraper (D-088 Apify-2) into `general_pricing_ranges`",
      new_string: "the DIY CruiseMapper scraper (D-999995 Apify-2) into `general_pricing_ranges`",
    });
    expect(code).toBe(2);
  });

  it("blocks when old_string touches two distinct D-numbers (ambiguous — not a single renumber)", () => {
    const { code } = runHook({
      file_path: "MEMORY.md",
      old_string: `## D-${BRANCH_LOCAL_A} — 2026-07-07 — Entry referencing D-999997 too\n\nbody`,
      new_string: `## D-${BRANCH_LOCAL_B} — 2026-07-07 — Entry referencing D-999996 too\n\nbody`,
    });
    expect(code).toBe(2);
  });

  it("blocks a non-MEMORY.md-touching case as before (regression: specs/ still protected)", () => {
    const { code, stderr } = runHook({
      file_path: "specs/foo.html",
      old_string: "a",
      new_string: "b",
    });
    expect(code).toBe(2);
    expect(stderr).toContain("specs/");
  });
});

describe("block-spec-memory-edits.mjs — Codex apply_patch protocol", () => {
  it("blocks patches targeting the read-only specs directory", () => {
    const { code, stderr } = runCodexPatch(`*** Begin Patch
*** Update File: specs/example.html
@@
-old
+new
*** End Patch`);

    expect(code).toBe(2);
    expect(stderr).toContain("specs/");
  });

  it("blocks patches that rewrite existing MEMORY history", () => {
    const firstLine = readFileSync(path.join(REPO_ROOT, "MEMORY.md"), "utf8").split("\n")[0];
    const { code, stderr } = runCodexPatch(`*** Begin Patch
*** Update File: MEMORY.md
@@
-${firstLine}
+# Rewritten history
*** End Patch`);

    expect(code).toBe(2);
    expect(stderr).toContain("MEMORY.md");
  });

  it("allows a prepend that preserves the current MEMORY content", () => {
    const prefix = readFileSync(path.join(REPO_ROOT, "MEMORY.md"), "utf8").split("\n").slice(0, 2);
    const context = prefix.map((line) => ` ${line}`).join("\n");
    const { code } = runCodexPatch(`*** Begin Patch
*** Update File: MEMORY.md
@@
+## D-999999 — Test-only prepend
+
${context}
*** End Patch`);

    expect(code).toBe(0);
  });

  it("allows an ordinary patch outside protected files", () => {
    const { code } = runCodexPatch(`*** Begin Patch
*** Update File: README.md
@@
-old
+new
*** End Patch`);

    expect(code).toBe(0);
  });

  it("fails closed when the Codex patch payload is malformed", () => {
    const missingCommand = runCodexPatch();
    const missingEndMarker = runCodexPatch("*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new");

    expect(missingCommand.code).toBe(2);
    expect(missingEndMarker.code).toBe(2);
    expect(missingCommand.stderr).toContain("malformed apply_patch");
  });
});
