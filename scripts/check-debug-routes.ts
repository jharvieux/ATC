// Debug/dev/test route guard (#1637) — presence check.
//
// A leftover `/api/debug`, `/api/dev`, or `/api/test*` route is a classic
// forgotten-scaffolding foothold: often unauthenticated, often echoing internal
// state. `check:admin-auth` guards the admin surface but not a debug-named
// route. This is zero-tolerance (no baseline) — none exist today, and a new one
// is almost always a mistake. If a debug endpoint is ever intentional, it must
// live behind the admin surface, not a debug-named path.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_DIRS = ["apps/main/src/app/api", "apps/rag/src/app/api"];

// A path segment that names the route as debug/dev/test scaffolding.
const FORBIDDEN_SEGMENT_RE = /^(debug|dev|test|tests)([-_].*)?$/i;

export function forbiddenSegment(relFromApi: string): string | null {
  for (const seg of relFromApi.split("/")) {
    // Route groups like (debug) still map to the same URL surface.
    const bare = seg.replace(/^\((.*)\)$/, "$1");
    if (FORBIDDEN_SEGMENT_RE.test(bare)) return seg;
  }
  return null;
}

function walkRoutes(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkRoutes(p));
    else if (/^route\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

function main(): void {
  const violations: { file: string; segment: string }[] = [];
  let scanned = 0;
  for (const dir of API_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    scanned++;
    for (const file of walkRoutes(abs)) {
      const relFromApi = path.relative(abs, path.dirname(file));
      const seg = forbiddenSegment(relFromApi);
      if (seg) violations.push({ file: path.relative(ROOT, file), segment: seg });
    }
  }
  if (scanned === 0) {
    console.error("Debug-route check: no API dirs found. Run from repo root.");
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error("Debug-route guard: route(s) under a debug/dev/test-named path:\n");
    for (const v of violations) console.error(`  ${v.file} (segment "${v.segment}")`);
    console.error("\nRemove the route or move it behind the authenticated admin surface.");
    process.exit(1);
  }
  console.log("Debug-route guard passed: no debug/dev/test-named API routes.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
