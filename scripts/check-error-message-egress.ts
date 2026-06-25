// Error-message egress guard (epic #1393 / G1; Day-1 scan F-leak-01/02/03, #1380).
//
// Flags raw DB/exception `.message` / `.details` echoed into an API response
// object (the `{ detail: error.message }` / `{ message: err.message }` /
// `error: \`...${e.message}\`` shape). Postgres/Supabase error messages embed
// table, column, and constraint names — schema disclosure to the caller. The
// safe pattern is `dbErrorResponse(error)` (lib/api/db-error-response.ts): log
// the real error server-side under a random ref, return a generic message.
//
// This is a TEXT pattern check, not taint analysis: it catches the direct
// `<key>: <err>.message` egress form. It does NOT catch indirection
// (`const m = err.message; send({ message: m })`) — that's a known gap; the
// audit agents cover it at PR time.
//
// FREEZE-EXISTING / BLOCK-NEW: the codebase already has ~70 instances of this
// convention (a broad cleanup tracked in its own issue). The baseline freezes
// those; the guard fails only on NEW occurrences. Baseline entries are keyed by
// `relpath::<normalized match>` (line-independent, so edits elsewhere in a file
// don't churn it). Remove an entry once that site routes through dbErrorResponse.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = path.join(ROOT, "scripts/error-message-egress-baseline.txt");
const API_DIRS = [
  "apps/main/src/app/api",
  "apps/rag/src/app/api",
];

// <key>: <expr ending in .message/.details> inside a response object literal.
const EGRESS_RE =
  /\b(?:detail|details|message|error|hint|reason)\s*:\s*[^,}\n]*\.(?:message|details)\b/g;

// <key>: String(<err-like expr>) — String(err) renders as "Error: <err.message>",
// disclosing the same schema info as .message directly.
const EGRESS_STRING_RE =
  /\b(?:detail|details|message|error|hint|reason)\s*:\s*String\s*\([^)]*(?:err|error|e|ex)\b[^)]*\)/g;

export interface Egress {
  file: string; // repo-relative
  key: string; // relpath::normalized-match
  snippet: string;
}

export function findEgress(relPath: string, content: string): Egress[] {
  const out: Egress[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue; // skip comments
    for (const re of [EGRESS_RE, EGRESS_STRING_RE]) {
      for (const m of line.matchAll(re)) {
        const snippet = m[0].trim().replace(/\s+/g, " ");
        out.push({ file: relPath, key: `${relPath}::${snippet}`, snippet });
      }
    }
  }
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

// Count-aware: each baseline line is `<count> <key>`. Keying by snippet alone
// would let a SECOND identical egress snippet in an already-baselined file slip
// through (it shares the key). The count caps how many occurrences of a key are
// grandfathered; a new duplicate pushes the live count over the baseline → fail.
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
  const found: Egress[] = [];
  let scannedDirs = 0;
  for (const dir of API_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    scannedDirs++;
    for (const file of walk(abs)) {
      const rel = path.relative(ROOT, file);
      found.push(...findEgress(rel, fs.readFileSync(file, "utf8")));
    }
  }
  if (scannedDirs === 0) {
    console.error("Error-message-egress check: no API dirs found. Run from repo root.");
    process.exit(1);
  }

  // Count occurrences per key in the live tree; fail if any key exceeds its
  // baselined count (a NEW occurrence — even a duplicate snippet in a file that
  // already has one).
  const liveCounts = new Map<string, { count: number; file: string; snippet: string }>();
  for (const e of found) {
    const cur = liveCounts.get(e.key);
    if (cur) cur.count++;
    else liveCounts.set(e.key, { count: 1, file: e.file, snippet: e.snippet });
  }
  const fresh: { file: string; snippet: string; excess: number }[] = [];
  for (const [key, v] of liveCounts) {
    const based = baseline.get(key) ?? 0;
    if (v.count > based) fresh.push({ file: v.file, snippet: v.snippet, excess: v.count - based });
  }
  // Stale baseline entries (a site was fixed / count dropped) are not a failure,
  // but report them so the baseline can be trimmed.
  const stale = [...baseline].filter(([key, based]) => (liveCounts.get(key)?.count ?? 0) < based);

  if (fresh.length > 0) {
    console.error(
      "Error-message-egress violations — raw error .message/.details echoed into an API response:\n",
    );
    for (const e of fresh) console.error(`  ${e.file}: ${e.snippet}${e.excess > 1 ? ` (x${e.excess} new)` : ""}`);
    console.error(
      `\n${fresh.length} NEW occurrence(s). Route the error through dbErrorResponse(error) ` +
        "(lib/api/db-error-response.ts) — log server-side under a ref, return a generic message. " +
        "Do NOT add to the baseline to silence this; the baseline is frozen pre-existing debt only.",
    );
    process.exit(1);
  }

  const note = stale.length > 0 ? ` (${stale.length} stale baseline entr(y/ies) — trim them)` : "";
  console.log(
    `Error-message-egress check passed: ${found.length} pre-existing site(s) baselined, 0 new` + note + ".",
  );
}

// Run only as a CLI — importing this module (the unit test, the baseline
// generator) must not trigger the scan/exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
