// Fetch-waterfall detector (audit) — M9 / audit-service.
//
// Flags runs of consecutive INDEPENDENT awaited assignments in async server code
// (`const a = await getX(); const b = await getY();` where b doesn't use a) — these
// serialize round-trips that could run in parallel via Promise.all([...]) or a single
// query. Heuristic / report-only (exit 0); a flagged run is a candidate for review,
// not a guaranteed defect (the calls may have hidden ordering).
//
// Usage: tsx scripts/check-fetch-waterfalls.ts [srcDir]   # default apps/main/src

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AWAIT_ASSIGN = /^\s*(?:const|let)\s+([A-Za-z0-9_]+)\s*=\s*await\s+(.+)$/;

export interface WaterfallFinding {
  file: string;
  line: number;
  independentAwaits: number;
}

// Pure core: returns the runs of >=2 independent consecutive awaited assignments.
export function findWaterfalls(relPath: string, contents: string): WaterfallFinding[] {
  if (!/\.(ts|tsx)$/.test(relPath)) return [];
  if (/\.(test|spec)\.|__tests__|\/fixtures\//.test(relPath)) return [];
  if (/^['"]use client['"]/m.test(contents)) return []; // client awaits aren't render-time DB waterfalls
  if (!/await\s+/.test(contents)) return [];

  const lines = contents.split("\n");
  const findings: WaterfallFinding[] = [];
  let run: { name: string; expr: string; line: number }[] = [];

  const flush = () => {
    if (run.length >= 2) {
      // count awaits whose expr doesn't reference any earlier var in the run
      let independent = 0;
      const seen: string[] = [];
      for (const a of run) {
        if (!seen.some((n) => new RegExp(`\\b${n}\\b`).test(a.expr))) independent++;
        seen.push(a.name);
      }
      if (independent >= 2) {
        findings.push({ file: relPath, line: run[0]!.line, independentAwaits: independent });
      }
    }
    run = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(AWAIT_ASSIGN);
    if (m) {
      run.push({ name: m[1]!, expr: m[2]!, line: i + 1 });
    } else if (lines[i]!.trim() === "" || lines[i]!.trim().startsWith("//")) {
      // tolerate blank/comment lines inside a run
    } else {
      flush();
    }
  }
  flush();
  return findings;
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

function main(): void {
  const srcDir = path.resolve(process.argv[2] ?? path.join(REPO_ROOT, "apps/main/src"));
  const findings = walk(srcDir).flatMap((abs) =>
    findWaterfalls(path.relative(REPO_ROOT, abs), fs.readFileSync(abs, "utf8")),
  );
  if (findings.length === 0) {
    console.log("fetch-waterfall guard: ok — no independent sequential-await runs found.");
    return;
  }
  console.error(`fetch-waterfall guard: ${findings.length} potential waterfall(s) — review for Promise.all / single query:\n`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  (${f.independentAwaits} independent awaits)`);
}

main();
