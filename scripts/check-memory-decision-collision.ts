// MEMORY.md decision-number collision gate (#1661).
//
// MEMORY.md is meant to be prepend-only (enforced for Edit/Write calls by
// .claude/hooks/block-spec-memory-edits.mjs), but that hook has a blind spot:
// merge-conflict resolution during a rebase is a raw filesystem write, not an
// Edit/Write tool call, so the hook never runs there. It's also useless
// against two DIFFERENT branches that each independently compute the same
// "next" D-number from the same dev snapshot — neither branch's hook run can
// see the other branch. The 2026-07-06 sweep produced exactly that: PRs
// #1652 and #1643 both added `## D-318` (renumbered to D-319 by hand after
// the fact). This is the CI-side backstop that catches it on the PR's final
// file content, regardless of how it got there.
//
// Two checks, both DB-free:
//
//   1. DUPLICATE D-NUMBER — a `## D-NNN` header this PR ADDS (present on
//      HEAD, absent from origin/<base>'s MEMORY.md) already exists in
//      origin/<base>'s MEMORY.md. Since MEMORY.md is prepend-only, "already
//      exists on the base" means some other, already-merged PR claimed this
//      exact number first.
//
//   2. INDEX/BODY MISMATCH — the set of `## D-NNN` headers in MEMORY.md (on
//      HEAD) must exactly match the UNION of `- D-NNN` entries across
//      MEMORY-INDEX.md and MEMORY-INDEX-ARCHIVE.md (on HEAD), with no
//      D-number appearing in both index files. A mismatch means a prepend to
//      one file wasn't mirrored to the other — usually a half-done renumber,
//      which is also how a duplicate slips through undetected. (The archive
//      split is D-366: the lean index is the session-start read; older
//      one-liners live in the archive.)
//
// Usage:
//   tsx scripts/check-memory-decision-collision.ts
//   MEMORY_COLLISION_BASE_REF=origin/release/x tsx scripts/check-memory-decision-collision.ts
//
// Exit 0 if consistent (or nothing to check). Exit 1 on any violation. A
// git-show failure (e.g. base ref not fetched, or MEMORY.md doesn't exist on
// the base yet) is a warning + skip that check — never block a PR on CI
// plumbing.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_REF = process.env.MEMORY_COLLISION_BASE_REF ?? "origin/dev";

const MEMORY_HEADER_RE = /^## (D-\d+)\b/gm;
const INDEX_ENTRY_RE = /^- (D-\d+)\b/gm;

// Exported for tests — pure regex extraction, no I/O.
export function extractMemoryHeaders(text: string): string[] {
  return [...text.matchAll(MEMORY_HEADER_RE)].map((m) => m[1]!);
}

export function extractIndexEntries(text: string): string[] {
  return [...text.matchAll(INDEX_ENTRY_RE)].map((m) => m[1]!);
}

// Pure core #1: a duplicate is a D-number this branch's diff ADDS (a new
// `+## D-NNN` line) that already exists in the base ref's MEMORY.md — i.e. a
// sibling PR already claimed it. `addedHeaders` must come from the diff, not
// a full head-vs-base header-set compare, so a pre-existing unmodified entry
// (which trivially appears in both sets) is never mistaken for a duplicate.
export function findDuplicateAdds(baseHeaders: string[], addedHeaders: string[]): string[] {
  const baseSet = new Set(baseHeaders);
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const h of addedHeaders) {
    if (baseSet.has(h) && !seen.has(h)) {
      duplicates.push(h);
      seen.add(h);
    }
  }
  return duplicates;
}

// Pure core #2: symmetric difference between MEMORY.md's headers and
// MEMORY-INDEX.md's entries.
export interface IndexMismatch {
  onlyInMemory: string[];
  onlyInIndex: string[];
}

export function findIndexMismatch(memoryHeaders: string[], indexEntries: string[]): IndexMismatch {
  const memSet = new Set(memoryHeaders);
  const idxSet = new Set(indexEntries);
  return {
    onlyInMemory: [...memSet].filter((h) => !idxSet.has(h)),
    onlyInIndex: [...idxSet].filter((h) => !memSet.has(h)),
  };
}

// Pure core #3: a D-number listed in BOTH the lean index and the archive is a
// half-done archive move — the line was copied down but not removed (or vice
// versa). Each number must live in exactly one of the two files.
export function findIndexOverlap(indexEntries: string[], archiveEntries: string[]): string[] {
  const archSet = new Set(archiveEntries);
  return [...new Set(indexEntries)].filter((h) => archSet.has(h));
}

function readFileAt(ref: string, relPath: string): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:${relPath}`], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

// Lines this PR's diff ADDS to MEMORY.md (`git diff` `+` lines), restricted to
// `## D-NNN` headers. Using the diff (not a full head-vs-base header-set
// compare) means an UNCHANGED pre-existing entry never counts as "added",
// even though it trivially also appears in both baseHeaders and headHeaders.
function addedMemoryHeaders(): { headers: string[]; ok: boolean } {
  try {
    const out = execFileSync(
      "git",
      ["diff", "--unified=0", `${BASE_REF}...HEAD`, "--", "MEMORY.md"],
      { encoding: "utf8", cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 },
    );
    const headers: string[] = [];
    for (const line of out.split("\n")) {
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      const m = line.slice(1).match(/^## (D-\d+)\b/);
      if (m) headers.push(m[1]!);
    }
    return { headers, ok: true };
  } catch {
    return { headers: [], ok: false };
  }
}

function main(): void {
  let anyFailure = false;

  // Check 1: duplicate D-number vs base.
  const baseMemory = readFileAt(BASE_REF, "MEMORY.md");
  const { headers: added, ok: diffOk } = addedMemoryHeaders();

  if (baseMemory === null || !diffOk) {
    console.warn(
      `memory-decision-collision guard: could not read MEMORY.md at ${BASE_REF} or diff against it — ` +
        "skipping the duplicate-D-number check.",
    );
  } else {
    const baseHeaders = extractMemoryHeaders(baseMemory);
    const duplicates = findDuplicateAdds(baseHeaders, added);
    if (duplicates.length > 0) {
      anyFailure = true;
      console.error(
        "memory-decision-collision guard: this PR adds a ## D-NNN header that already exists " +
          `on ${BASE_REF} — a sibling PR already claimed this number.\n`,
      );
      for (const d of duplicates) {
        console.error(
          `  ${d} already exists on ${BASE_REF}.\n` +
            "    Fix: renumber this branch's entry to the next free D-number (rebase on the base ref " +
            "first to see the current highest), per docs/runbooks — see .claude/commands/memory-entry.md.\n",
        );
      }
    } else {
      console.log("memory-decision-collision guard: ok — no duplicate D-number vs base.");
    }
  }

  // Check 2: MEMORY.md vs (MEMORY-INDEX.md ∪ MEMORY-INDEX-ARCHIVE.md) header-set
  // consistency on HEAD, plus no-overlap between the two index files.
  const memoryPath = path.join(REPO_ROOT, "MEMORY.md");
  const indexPath = path.join(REPO_ROOT, "MEMORY-INDEX.md");
  const archivePath = path.join(REPO_ROOT, "MEMORY-INDEX-ARCHIVE.md");
  if (!fs.existsSync(memoryPath) || !fs.existsSync(indexPath)) {
    console.warn("memory-decision-collision guard: MEMORY.md or MEMORY-INDEX.md missing — skipping index-consistency check.");
  } else {
    const memoryHeaders = extractMemoryHeaders(fs.readFileSync(memoryPath, "utf8"));
    const indexEntries = extractIndexEntries(fs.readFileSync(indexPath, "utf8"));
    const archiveEntries = fs.existsSync(archivePath)
      ? extractIndexEntries(fs.readFileSync(archivePath, "utf8"))
      : [];
    const overlap = findIndexOverlap(indexEntries, archiveEntries);
    if (overlap.length > 0) {
      anyFailure = true;
      console.error(
        "memory-decision-collision guard: D-number(s) present in BOTH MEMORY-INDEX.md and " +
          `MEMORY-INDEX-ARCHIVE.md (half-done archive move): ${overlap.join(", ")}\n` +
          "  Fix: each number belongs in exactly one of the two files — remove it from one.\n",
      );
    }
    const mismatch = findIndexMismatch(memoryHeaders, [...indexEntries, ...archiveEntries]);
    if (mismatch.onlyInMemory.length > 0 || mismatch.onlyInIndex.length > 0) {
      anyFailure = true;
      console.error("memory-decision-collision guard: MEMORY.md and the index files' header sets disagree.\n");
      if (mismatch.onlyInMemory.length > 0) {
        console.error(`  In MEMORY.md but missing from both index files: ${mismatch.onlyInMemory.join(", ")}`);
      }
      if (mismatch.onlyInIndex.length > 0) {
        console.error(`  In an index file but missing from MEMORY.md: ${mismatch.onlyInIndex.join(", ")}`);
      }
      console.error(
        "\n  Fix: prepend the missing one-liner to MEMORY-INDEX.md (new entries), or rerun the archive " +
          "rebuild snippet in MEMORY-INDEX-ARCHIVE.md's header.\n",
      );
    } else if (overlap.length === 0) {
      console.log("memory-decision-collision guard: ok — MEMORY.md and the index files' header sets match.");
    }
  }

  if (anyFailure) process.exit(1);
}

// Only run when invoked directly (`tsx scripts/check-memory-decision-collision.ts`);
// importing the module for unit tests must NOT trigger git calls or exit.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
