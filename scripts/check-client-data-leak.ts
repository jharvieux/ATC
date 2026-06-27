// Server→client data-leak detector (audit, HEURISTIC) — M9 / audit-service.
//
// The highest-value M9 security check, and the hardest to do statically: a Server
// Component passing a whole DB object to a Client Component prop serializes EVERY
// field into the browser payload (other-tenant data, secrets, hashes), even those
// the client never renders.
//
// Two-pass heuristic: (1) collect Client Component export names (files with
// 'use client'); (2) in server files, flag JSX usages of a known Client Component
// that receive an object SPREAD (`<ClientComp {...row} />`) — the canonical leak
// shape. Report-only / needs-review: a spread of a small, already-projected props
// object is a false positive. A precise version needs ts-morph + type info (Tier 2).
//
// Usage: tsx scripts/check-client-data-leak.ts [srcDir]   # default apps/main/src

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      out.push(...walk(full));
    } else if (/\.(tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

// Exported for tests. clientComps = set of component names declared in 'use client' files.
export function findClientLeakSpreads(
  relPath: string,
  contents: string,
  clientComps: Set<string>,
): { component: string; line: number }[] {
  if (/\.(test|spec)\./.test(relPath)) return [];
  if (/^['"]use client['"]/m.test(contents)) return []; // a client file passing to a client child stays client-side
  const out: { component: string; line: number }[] = [];
  const lines = contents.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // <ClientComp ... {...something} ... >
    const m = lines[i]!.match(/<([A-Z][A-Za-z0-9_]*)\b[^>]*\{\.\.\.[A-Za-z0-9_.]+\}/);
    if (m && clientComps.has(m[1]!)) out.push({ component: m[1]!, line: i + 1 });
  }
  return out;
}

// Collect component names exported from a 'use client' module.
export function clientComponentNames(contents: string): string[] {
  if (!/^['"]use client['"]/m.test(contents)) return [];
  const names = new Set<string>();
  for (const m of contents.matchAll(/export\s+(?:default\s+)?function\s+([A-Z][A-Za-z0-9_]*)/g)) names.add(m[1]!);
  for (const m of contents.matchAll(/export\s+const\s+([A-Z][A-Za-z0-9_]*)\s*[:=]/g)) names.add(m[1]!);
  return [...names];
}

function main(): void {
  const srcDir = path.resolve(process.argv[2] ?? path.join(REPO_ROOT, "apps/main/src"));
  const files = walk(srcDir).map((abs) => ({ rel: path.relative(REPO_ROOT, abs), contents: fs.readFileSync(abs, "utf8") }));
  const clientComps = new Set<string>();
  for (const f of files) for (const n of clientComponentNames(f.contents)) clientComps.add(n);

  const findings = files.flatMap((f) =>
    findClientLeakSpreads(f.rel, f.contents, clientComps).map((x) => ({ ...x, file: f.rel })),
  );
  if (findings.length === 0) {
    console.log(`client-data-leak guard: ok — no object-spread onto a Client Component from server files (${clientComps.size} client comps scanned).`);
    return;
  }
  console.error(`client-data-leak guard (HEURISTIC — review each): ${findings.length} spread(s) onto a Client Component from a server file:\n`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  <${f.component} {...}> — confirm only client-needed fields cross the boundary`);
}

main();
