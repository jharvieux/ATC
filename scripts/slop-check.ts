#!/usr/bin/env tsx
// D-091 slop-reduction — diff-aware slop scanner.
//
// Scans `git diff <base>..HEAD` (default base: origin/dev) for patterns that
// commonly indicate AI-generated slop:
//   1. Orphan TODO/FIXME/XXX/HACK markers (no owner or issue ref).
//   2. Narrating comments (short, verb-prefixed, describing the next line).
//   3. Try/catch that just re-throws.
//   4. Single-line export wrappers (function bodies = one return statement).
//
// Output: markdown findings to stdout. Exit 0 (advisory). Designed to run
// in a CI workflow that posts the markdown back as a PR comment.
//
// The ESLint rules in `packages/config/eslint-rules/no-{orphan-todo,narrating-comments}`
// cover patterns 1 and 2 at lint time. This script duplicates them so a PR
// surfaces *new* slop in the diff context regardless of whether the rules
// are switched on at warn/error level in the affected file.

import { execFileSync, execSync } from "node:child_process";
import * as path from "node:path";

const BASE_REF = process.env.SLOP_CHECK_BASE_REF ?? "origin/dev";
const SCAN_EXT = [".ts", ".tsx", ".js", ".jsx"];

interface Finding {
  file: string;
  line: number;
  kind: "orphan-todo" | "narrating-comment" | "rethrow-catch" | "wrapper-fn";
  message: string;
  snippet: string;
}

const MARKERS = ["TODO", "FIXME", "XXX", "HACK"];
const MARKER_GROUP = `(${MARKERS.join("|")})`;
const LINE_MARKER_RE = new RegExp(`^//\\s*${MARKER_GROUP}\\b(?!\\s*\\()`);
const PAREN_MARKER_RE = new RegExp(`\\(\\s*${MARKER_GROUP}\\b(?!\\s*[@#]|\\()`);

const NARRATING_RE =
  /^\/\/\s*(loop|iterate|fetch|set|get|load|store|save|validate|verify|check|ensure|create|update|delete|remove|initialize|init|return|build|parse|compute|calculate|handle|process|read|write|apply|execute|invoke|call|trigger)(\s+(the|a|an|all|every|this|that|each|some|any))?\s+\w+\.?\s*$/i;

const DIRECTIVE_RE =
  /^\/\/\s*(eslint|ts-|prettier|@|§|#|D-\d|bp\d+|--|=|>|---|\*)/i;

// `} catch (err) { throw err; }` pattern (allowing whitespace + var rename).
const RETHROW_CATCH_RE =
  /catch\s*\(\s*(\w+)\s*\)\s*\{\s*throw\s+\1\s*;?\s*\}/;

// Single-expression export wrapper: `export function foo(x) { return bar(x); }`
const WRAPPER_FN_RE =
  /^export\s+(?:async\s+)?function\s+\w+\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*return\s+[^;]+;\s*\}/m;

function getChangedFiles(): string[] {
  const out = execSync(`git diff --name-only --diff-filter=AM ${BASE_REF}...HEAD`, {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && SCAN_EXT.includes(path.extname(line)))
    .filter((line) => !line.includes("node_modules"))
    .filter((line) => !line.includes("/test/") && !line.endsWith(".test.ts") && !line.endsWith(".test.tsx"))
    .filter((line) => !line.startsWith("scripts/"))
    .filter((line) => !line.startsWith("packages/config/"));
}

function getAddedLinesForFile(file: string): Map<number, string> {
  // Use `git diff --unified=0` to get just the changed hunks. Parse to map
  // new-file line numbers → content. execFileSync (not execSync) so paths
  // with shell metacharacters like `(admin)` route groups don't break.
  const diff = execFileSync(
    "git",
    ["diff", "--unified=0", `${BASE_REF}...HEAD`, "--", file],
    { encoding: "utf8" },
  );
  const lines = new Map<number, string>();
  let newLineNum = 0;
  for (const raw of diff.split("\n")) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLineNum = parseInt(hunk[1]!, 10);
      continue;
    }
    if (raw.startsWith("+++")) continue;
    if (raw.startsWith("+")) {
      lines.set(newLineNum, raw.slice(1));
      newLineNum += 1;
    } else if (!raw.startsWith("-")) {
      newLineNum += 1;
    }
  }
  return lines;
}

function scanFile(file: string, addedLines: Map<number, string>, findings: Finding[]): void {
  // Orphan TODO + narrating-comment checks are line-local.
  for (const [lineNum, content] of addedLines) {
    const trimmed = content.trim();
    if (LINE_MARKER_RE.test(trimmed) || PAREN_MARKER_RE.test(trimmed)) {
      const markerMatch =
        trimmed.match(LINE_MARKER_RE) ?? trimmed.match(PAREN_MARKER_RE);
      findings.push({
        file,
        line: lineNum,
        kind: "orphan-todo",
        message: `Orphan ${markerMatch?.[1]} marker — add an owner or issue ref: ${markerMatch?.[1]}(owner) or ${markerMatch?.[1]}(#123).`,
        snippet: trimmed.slice(0, 100),
      });
    }
    if (!DIRECTIVE_RE.test(trimmed) && NARRATING_RE.test(trimmed)) {
      findings.push({
        file,
        line: lineNum,
        kind: "narrating-comment",
        message: "Comment narrates what the next line does. Delete it or rewrite to explain WHY.",
        snippet: trimmed.slice(0, 100),
      });
    }
  }

  // Multi-line scans: re-read added blocks and look for re-throw + wrappers.
  // Conservative — only flags patterns where ALL referenced lines are in the diff.
  const sortedLines = [...addedLines.entries()].sort(([a], [b]) => a - b);
  for (let i = 0; i < sortedLines.length; i += 1) {
    const window = sortedLines
      .slice(i, i + 6)
      .map(([, c]) => c)
      .join("\n");
    const rethrowMatch = window.match(RETHROW_CATCH_RE);
    if (rethrowMatch) {
      findings.push({
        file,
        line: sortedLines[i]![0],
        kind: "rethrow-catch",
        message: "try/catch that just re-throws is a no-op. Delete it; let the error propagate.",
        snippet: rethrowMatch[0].slice(0, 100),
      });
    }
    const wrapperMatch = window.match(WRAPPER_FN_RE);
    if (wrapperMatch) {
      findings.push({
        file,
        line: sortedLines[i]![0],
        kind: "wrapper-fn",
        message: "Single-expression wrapper function. Consider inlining at the call site if used only once.",
        snippet: wrapperMatch[0].slice(0, 100),
      });
    }
  }
}

function emitMarkdown(findings: Finding[]): string {
  if (findings.length === 0) {
    return "## Slop check — clean\n\nNo slop patterns detected in this PR diff. ✓\n";
  }
  const byKind = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!byKind.has(f.kind)) byKind.set(f.kind, []);
    byKind.get(f.kind)!.push(f);
  }
  const sections: string[] = ["## Slop check — findings\n"];
  sections.push(
    `Found ${findings.length} potential slop pattern${findings.length === 1 ? "" : "s"} in this PR. These are advisory — review each and either fix or justify.\n`,
  );
  const labels: Record<string, string> = {
    "orphan-todo": "Orphan TODO/FIXME (no owner or issue ref)",
    "narrating-comment": "Narrating comment (describes WHAT, not WHY)",
    "rethrow-catch": "try/catch that just re-throws",
    "wrapper-fn": "Single-expression wrapper function",
  };
  for (const [kind, items] of byKind) {
    sections.push(`### ${labels[kind] ?? kind} (${items.length})\n`);
    for (const f of items) {
      sections.push(`- \`${f.file}:${f.line}\` — ${f.message}\n  \`\`\`\n  ${f.snippet}\n  \`\`\``);
    }
    sections.push("");
  }
  sections.push(
    "_Generated by `pnpm slop-check`. See `docs/runbooks/slop-detection.md` for rationale and how to silence false positives._",
  );
  return sections.join("\n");
}

function main(): void {
  const files = getChangedFiles();
  const findings: Finding[] = [];
  for (const file of files) {
    const added = getAddedLinesForFile(file);
    if (added.size === 0) continue;
    scanFile(file, added, findings);
  }
  process.stdout.write(emitMarkdown(findings));
}

main();
