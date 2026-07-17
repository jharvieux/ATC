// Serial-await-in-loop detector (audit) — #1951 / companion to check-fetch-waterfalls.
//
// The #1789 sweep leaned on an external Harvey `detect-static` scanner that is
// NOT in this repo, so its "62 candidate sites" were never reproducible. This
// script makes the count reproducible: it enumerates loops whose body directly
// `await`s once per iteration — the N+1 serial-await pattern that bounded
// `Promise.all` / `mapWithConcurrency` fan-out fixes when the iterations are
// independent.
//
// Scope: `apps/*/src/inngest/**` and `apps/*/src/lib/cron/**` (the background-job
// directories #1789/#1951 name). A flagged loop is a REVIEW candidate, not a
// confirmed defect: the iterations may be genuinely sequential (each needs the
// prior result), claim/send-ordered, or time-budget guarded, all of which must
// stay serial.
//
// What counts as a finding: an `await` whose nearest enclosing function-or-loop
// scope is a LOOP (`for`/`for..of`/`for..in`/`while`/`do`). Deliberately EXCLUDED:
//   - `for await (…)` async iteration (the await IS the loop, not per-item work).
//   - awaits nested inside a callback (`.map(async …)`, `mapWithConcurrency(…)`,
//     `Promise.all([...map])`) — a function scope intervenes, so they are already
//     fanned out (or a different concern).
// One finding per loop header (deduped), reported as file:loopLine.
//
// Suppression: a loop reviewed and deliberately kept serial carries a
// `serial-await-ok: <reason>` comment on the loop's header line or the line
// directly above it. Suppressed loops are excluded so a future sweep does not
// re-litigate a decision already made (e.g. the #1952 sites).
//
// CI gate (#1985): FREEZE-EXISTING / BLOCK-NEW, same doctrine as
// check-unbounded-select.ts. Pre-existing un-annotated findings are frozen in
// scripts/serial-await-baseline.txt (count-keyed by file, line-independent —
// loop lines drift as files change). The guard fails only when a file's live
// finding count exceeds its baseline. Suppress a genuinely-serial loop with
// `serial-await-ok` instead of adding to the baseline; only use the baseline
// for sites still awaiting review.
//
// Usage: tsx scripts/check-serial-await-in-loop.ts [srcDir ...]   # default: the two dirs above

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = path.join(REPO_ROOT, "scripts/serial-await-baseline.txt");

export interface SerialAwaitFinding {
  file: string;
  loopLine: number;
  loopKind: string;
}

type ScopeKind = "loop" | "func" | "block";
interface Scope {
  kind: ScopeKind;
  loopKind: string;
  headerLine: number;
}

// Classify the block a `{` opens, from the significant text preceding it
// (strings/comments already collapsed by the walker's buffer). Returns the
// scope kind plus, for loops, the concrete keyword.
function classifyBrace(buffer: string): { kind: ScopeKind; loopKind: string } {
  const trimmed = buffer.replace(/\s+$/, "");
  if (trimmed.endsWith("=>")) return { kind: "func", loopKind: "" };
  if (trimmed.endsWith(")")) {
    // Walk back to the matching "(" to read the construct keyword before it.
    let depth = 0;
    let i = trimmed.length - 1;
    for (; i >= 0; i--) {
      const c = trimmed[i]!;
      if (c === ")") depth++;
      else if (c === "(") {
        depth--;
        if (depth === 0) break;
      }
    }
    const before = trimmed.slice(0, i).replace(/\s+$/, "");
    const kw = before.match(/([A-Za-z_$][\w$]*)$/)?.[1] ?? "";
    if (kw === "for") {
      // `for await (…)` → the await is the iteration protocol, not per-item work,
      // so treat its body like a non-loop scope (a nested await isn't N+1).
      return before.match(/for\s+await\s*$/)
        ? { kind: "func", loopKind: "for-await" }
        : { kind: "loop", loopKind: "for" };
    }
    if (kw === "while") return { kind: "loop", loopKind: "while" };
    if (kw === "if" || kw === "switch" || kw === "catch" || kw === "else")
      return { kind: "block", loopKind: "" };
    // function declaration / method / call-arg arrow with parens → function scope.
    return { kind: "func", loopKind: "" };
  }
  // `do {` has no parens.
  if (/\bdo$/.test(trimmed)) return { kind: "loop", loopKind: "do" };
  return { kind: "block", loopKind: "" };
}

export function findSerialAwaitsInLoops(relPath: string, contents: string): SerialAwaitFinding[] {
  if (!/\.(ts|tsx)$/.test(relPath)) return [];
  if (/\.(test|spec)\.|__tests__|\/fixtures\//.test(relPath)) return [];
  if (!/await/.test(contents)) return [];

  const srcLines = contents.split("\n");
  // Suppressed if `serial-await-ok` appears on the loop's header line or anywhere
  // in the contiguous comment block directly above it (so a multi-line rationale
  // still counts). Scanning stops at the first non-comment, non-blank line.
  const suppressed = (headerLine: number): boolean => {
    if (/serial-await-ok/.test(srcLines[headerLine - 1] ?? "")) return true;
    for (let ln = headerLine - 2; ln >= 0; ln--) {
      const t = (srcLines[ln] ?? "").trim();
      if (t === "") continue;
      if (!t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")) break;
      if (/serial-await-ok/.test(t)) return true;
    }
    return false;
  };

  const findings: SerialAwaitFinding[] = [];
  const reportedLoopLines = new Set<number>();
  const stack: Scope[] = [];
  let buffer = "";
  let line = 1;
  let inString: string | null = null; // ' " `
  const templateStack: number[] = []; // paren-ish depth markers for ${} in template literals
  let inLineComment = false;
  let inBlockComment = false;

  const text = contents;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];

    if (c === "\n") {
      line++;
      inLineComment = false;
      buffer = "";
      continue;
    }
    if (inLineComment) continue;
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (inString === "`" && c === "$" && next === "{") {
        // Enter a template-expression: braces here are expression braces, not scopes.
        templateStack.push(1);
        inString = null;
        i++;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    // Not in a string/comment:
    if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      inString = c;
      buffer += c;
      continue;
    }

    if (templateStack.length > 0) {
      // Inside a ${...} expression — track nested braces, and resume the
      // template string when this expression closes.
      if (c === "{") templateStack[templateStack.length - 1]!++;
      else if (c === "}") {
        templateStack[templateStack.length - 1]!--;
        if (templateStack[templateStack.length - 1] === 0) {
          templateStack.pop();
          inString = "`";
        }
      }
      continue;
    }

    if (c === "{") {
      const { kind, loopKind } = classifyBrace(buffer);
      stack.push({ kind, loopKind, headerLine: line });
      buffer = "";
      continue;
    }
    if (c === "}") {
      stack.pop();
      buffer = "";
      continue;
    }

    buffer += c;

    // Detect the `await` keyword at a word boundary.
    if (c === "t" && /await$/.test(buffer) && !/[\w$]await$/.test(buffer)) {
      const after = text[i + 1];
      if (after === undefined || !/[\w$]/.test(after)) {
        // Find nearest enclosing function-or-loop scope.
        for (let s = stack.length - 1; s >= 0; s--) {
          const sc = stack[s]!;
          if (sc.kind === "func") break; // callback / fan-out — not a direct serial-in-loop await
          if (sc.kind === "loop") {
            if (!reportedLoopLines.has(sc.headerLine)) {
              reportedLoopLines.add(sc.headerLine);
              if (!suppressed(sc.headerLine)) {
                findings.push({ file: relPath, loopLine: sc.headerLine, loopKind: sc.loopKind });
              }
            }
            break;
          }
        }
      }
    }
  }

  return findings.sort((a, b) => a.loopLine - b.loopLine);
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

function defaultDirs(): string[] {
  const dirs: string[] = [];
  for (const app of ["main", "rag"]) {
    dirs.push(path.join(REPO_ROOT, `apps/${app}/src/inngest`));
    dirs.push(path.join(REPO_ROOT, `apps/${app}/src/lib/cron`));
  }
  return dirs;
}

// Optional `file` param (default: the repo's real baseline) so tests can exercise
// a missing file without touching the checked-in baseline.
export function loadBaseline(file: string = BASELINE_FILE): Map<string, number> {
  const map = new Map<string, number>();
  if (!fs.existsSync(file)) return map;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sp = line.indexOf(" ");
    const count = Number(line.slice(0, sp));
    const f = line.slice(sp + 1);
    if (Number.isFinite(count) && count > 0 && f) map.set(f, count);
  }
  return map;
}

export interface BaselineDiff {
  fresh: { file: string; excess: number }[];
  stale: [string, number][];
}

export function diffAgainstBaseline(
  liveCounts: Map<string, number>,
  baseline: Map<string, number>,
): BaselineDiff {
  const fresh: { file: string; excess: number }[] = [];
  for (const [file, count] of liveCounts) {
    const based = baseline.get(file) ?? 0;
    if (count > based) fresh.push({ file, excess: count - based });
  }
  const stale = [...baseline].filter(([file, based]) => (liveCounts.get(file) ?? 0) < based);
  return { fresh, stale };
}

// Zero files scanned means the scanned dirs are gone (renamed/moved) — fail
// loud instead of silently reporting "0 baselined, 0 new" forever.
export function noFilesScannedMessage(fileCount: number): string | null {
  return fileCount === 0
    ? "serial-await-in-loop guard: no files found under scanned dirs — check paths."
    : null;
}

function main(): void {
  const argDirs = process.argv.slice(2);
  const dirs = argDirs.length > 0 ? argDirs.map((d) => path.resolve(d)) : defaultDirs();
  const files = dirs.flatMap(walk);
  const noFilesMsg = noFilesScannedMessage(files.length);
  if (noFilesMsg) {
    console.error(noFilesMsg);
    process.exit(1);
  }
  const findings = files.flatMap((abs) =>
    findSerialAwaitsInLoops(path.relative(REPO_ROOT, abs), fs.readFileSync(abs, "utf8")),
  );

  const liveCounts = new Map<string, number>();
  for (const f of findings) liveCounts.set(f.file, (liveCounts.get(f.file) ?? 0) + 1);

  const baseline = loadBaseline();
  const { fresh, stale } = diffAgainstBaseline(liveCounts, baseline);

  if (fresh.length > 0) {
    console.error(
      "serial-await-in-loop guard: NEW per-iteration await(s) — review for Promise.all / mapWithConcurrency," +
        " or suppress with `serial-await-ok: <reason>` if the loop must stay serial:\n",
    );
    for (const f of findings) {
      if (fresh.some((e) => e.file === f.file)) console.error(`  ${f.file}:${f.loopLine}  (${f.loopKind})`);
    }
    console.error(
      `\n${fresh.reduce((n, e) => n + e.excess, 0)} NEW finding(s) beyond scripts/serial-await-baseline.txt.`,
    );
    process.exit(1);
  }

  const note = stale.length > 0 ? ` (${stale.length} stale baseline entr(y/ies) — trim them)` : "";
  console.log(
    `serial-await-in-loop guard passed: ${findings.length} pre-existing site(s) baselined, 0 new` +
      note +
      ".",
  );
}

// Only run main() when invoked directly (not when imported by the unit test).
if (process.argv[1] && path.resolve(process.argv[1]).includes("check-serial-await-in-loop")) {
  main();
}
