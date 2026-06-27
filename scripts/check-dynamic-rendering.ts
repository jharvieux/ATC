// Accidental-dynamic-rendering detector (audit) — M9 / audit-service.
//
// Flags App Router pages/layouts that read a dynamic API (`searchParams`,
// `headers()`, `cookies()`, `draftMode()`, `noStore()` / `unstable_noStore`, or
// `export const dynamic = 'force-dynamic'`). Each forces per-request dynamic SSR —
// every hit re-renders and re-runs its queries (Vercel + DB cost). Often intended
// (auth'd dashboards); report-only, for "confirm this page must be dynamic" review.
//
// Usage: tsx scripts/check-dynamic-rendering.ts [srcDir]   # default apps/main/src/app

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SIGNALS: { re: RegExp; label: string }[] = [
  { re: /\bheaders\s*\(\s*\)/, label: "headers()" },
  { re: /\bcookies\s*\(\s*\)/, label: "cookies()" },
  { re: /\bdraftMode\s*\(\s*\)/, label: "draftMode()" },
  { re: /\b(?:unstable_)?noStore\s*\(\s*\)/, label: "noStore()" },
  { re: /\bsearchParams\b/, label: "searchParams" },
  { re: /export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/, label: "dynamic='force-dynamic'" },
];

export interface DynFinding {
  file: string;
  signals: string[];
}

// Pure core — only page/layout entry files (those define route render mode).
export function findDynamicOptIn(relPath: string, contents: string): DynFinding | null {
  if (!/\/app\/.*\/(page|layout)\.(tsx|ts)$/.test(relPath) && !/\/app\/(page|layout)\.(tsx|ts)$/.test(relPath))
    return null;
  if (/\.(test|spec)\./.test(relPath)) return null;
  const signals = SIGNALS.filter((s) => s.re.test(contents)).map((s) => s.label);
  return signals.length ? { file: relPath, signals } : null;
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
  const srcDir = path.resolve(process.argv[2] ?? path.join(REPO_ROOT, "apps/main/src/app"));
  const findings = walk(srcDir)
    .map((abs) => findDynamicOptIn(path.relative(REPO_ROOT, abs), fs.readFileSync(abs, "utf8")))
    .filter((f): f is DynFinding => f !== null);
  if (findings.length === 0) {
    console.log("dynamic-rendering guard: ok — no pages opt into dynamic rendering.");
    return;
  }
  console.error(`dynamic-rendering guard: ${findings.length} page(s) forced dynamic (confirm intended — else lose static/ISR caching):\n`);
  for (const f of findings) console.error(`  ${f.file}  [${f.signals.join(", ")}]`);
}

main();
