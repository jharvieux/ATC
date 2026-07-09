// Unbounded-select guard (#1613 item 6; D-091 #25 "bounded queries on
// user-growing tables", M4/M9 audit class).
//
// Flags `.from("<user-growing table>") … .select(…)` chains that carry no
// `.limit(` / `.range(` (nor a single-row / count-only terminator). On a table
// that grows with usage, an unbounded select silently truncates at PostgREST's
// default cap and returns a partial result with no error — a correctness bug,
// not just a perf one.
//
// This is a PRESENCE check, not a correctness proof (same doctrine as the
// #1393 G1–G6 guards): it inspects the text window from `.from(table)` to the
// end of the statement. Indirection (building the query across variables) is a
// known gap; the audit agents cover it at PR time.
//
// FREEZE-EXISTING / BLOCK-NEW: pre-existing sites are frozen in
// scripts/unbounded-select-baseline.txt (count-keyed, line-independent). The
// guard fails only on NEW occurrences. Remove a baseline entry once that query
// gains a .limit()/.range() or is confirmed intentionally whole-table.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = path.join(ROOT, "scripts/unbounded-select-baseline.txt");
const SRC_DIRS = ["apps/main/src", "apps/rag/src"];

// Tables that grow with tenant/user activity. Exact names + prefix families.
const WATCHED_EXACT = new Set([
  "messages",
  "conversations",
  "quotes",
  "notifications",
  "email_log",
  "ai_call_log",
]);
const WATCHED_PREFIXES = ["forum_"];

// A bounding terminator anywhere in the statement window clears the finding.
const BOUNDED_RE = /\.(?:limit|range|single|maybeSingle)\s*\(|head\s*:\s*true|count\s*:\s*["']exact["']\s*,\s*head/;

function isWatched(table: string): boolean {
  if (WATCHED_EXACT.has(table)) return true;
  return WATCHED_PREFIXES.some((p) => table.startsWith(p));
}

export interface Finding {
  file: string; // repo-relative
  key: string; // relpath::table
  table: string;
}

// Scan a file's text for `.from("<watched>")` whose forward statement window
// contains `.select(` but no bounding terminator.
export function findUnbounded(relPath: string, content: string): Finding[] {
  const out: Finding[] = [];
  const fromRe = /\.from\(\s*["'`]([a-z0-9_]+)["'`]\s*\)/g;
  for (const m of content.matchAll(fromRe)) {
    const table = m[1];
    if (!isWatched(table)) continue;
    const start = m.index ?? 0;
    // Window = from the .from(...) to the end of the statement. Chains end at
    // the first `;` after the call; cap the window so a missing `;` can't run
    // away across the file.
    const rest = content.slice(start, start + 1200);
    const semi = rest.indexOf(";");
    const window = semi === -1 ? rest : rest.slice(0, semi);
    if (!/\.select\s*\(/.test(window)) continue; // not a read
    if (BOUNDED_RE.test(window)) continue; // bounded
    out.push({ file: relPath, key: `${relPath}::${table}`, table });
  }
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      out.push(...walk(p));
    } else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

function loadBaseline(): Map<string, number> {
  const map = new Map<string, number>();
  if (!fs.existsSync(BASELINE_FILE)) return map;
  for (const raw of fs.readFileSync(BASELINE_FILE, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sp = line.indexOf(" ");
    const count = Number(line.slice(0, sp));
    const key = line.slice(sp + 1);
    if (Number.isFinite(count) && count > 0 && key) map.set(key, count);
  }
  return map;
}

function main(): void {
  const baseline = loadBaseline();
  const found: Finding[] = [];
  let scanned = 0;
  for (const dir of SRC_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    scanned++;
    for (const file of walk(abs)) {
      const rel = path.relative(ROOT, file);
      found.push(...findUnbounded(rel, fs.readFileSync(file, "utf8")));
    }
  }
  if (scanned === 0) {
    console.error("Unbounded-select check: no src dirs found. Run from repo root.");
    process.exit(1);
  }

  const liveCounts = new Map<string, { count: number; file: string; table: string }>();
  for (const f of found) {
    const cur = liveCounts.get(f.key);
    if (cur) cur.count++;
    else liveCounts.set(f.key, { count: 1, file: f.file, table: f.table });
  }
  const fresh: { file: string; table: string; excess: number }[] = [];
  for (const [key, v] of liveCounts) {
    const based = baseline.get(key) ?? 0;
    if (v.count > based) fresh.push({ file: v.file, table: v.table, excess: v.count - based });
  }
  const stale = [...baseline].filter(([key, based]) => (liveCounts.get(key)?.count ?? 0) < based);

  if (fresh.length > 0) {
    console.error(
      "Unbounded-select violations — .select() on a user-growing table with no .limit()/.range():\n",
    );
    for (const e of fresh) {
      console.error(`  ${e.file}: from("${e.table}")${e.excess > 1 ? ` (x${e.excess} new)` : ""}`);
    }
    console.error(
      `\n${fresh.length} NEW occurrence(s). Add .limit()/.range() (or .single()/.maybeSingle() ` +
        "for a single row). If the whole table is intentionally read, add a baseline entry with a " +
        "one-line reason — do NOT silence blindly.",
    );
    process.exit(1);
  }

  const note = stale.length > 0 ? ` (${stale.length} stale baseline entr(y/ies) — trim them)` : "";
  console.log(
    `Unbounded-select check passed: ${found.length} pre-existing site(s) baselined, 0 new` + note + ".",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
