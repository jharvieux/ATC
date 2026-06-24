// URL-validator guard (epic #1393 / G2; Day-1 scan F-rag-pii-02/F-ssrf-01).
//
// Stored/ingested URL fields that get persisted and later rendered (or fetched)
// must validate with `safeUrl` from @atc/contracts (http/https + internal-host
// deny), NOT a bare `z.string().url()` (which accepts file://, cloud-metadata,
// and RFC1918 hosts). This guard fails on any NEW `z.string().url()` in app /
// contract code.
//
// EXEMPT: `env.ts` files — those validate operator-set config URLs, are trusted,
// and include non-http schemes (e.g. redis://) that safeUrl deliberately
// rejects. Comment lines are skipped. The safe-url.ts definition documents the
// pattern in comments and is covered by the comment skip.
//
// Text pattern check (not type analysis); covers the `z.string().url()` form.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = path.join(ROOT, "scripts/url-validator-baseline.txt");
const SCAN_DIRS = ["apps/main/src", "apps/rag/src", "packages/contracts/src"];
const URL_RE = /z\.string\(\)\.url\(\)/g;

export interface UrlHit {
  file: string;
  key: string;
}

// Exempt operator-config env validation (trusted; non-http schemes allowed).
function isExempt(rel: string): boolean {
  return rel.endsWith("/env.ts") || rel.endsWith("env.ts");
}

export function findUrlValidators(rel: string, content: string): UrlHit[] {
  const out: UrlHit[] = [];
  content.split("\n").forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return; // skip comments
    if (URL_RE.test(line)) out.push({ file: rel, key: `${rel}:${i + 1}` });
    URL_RE.lastIndex = 0;
  });
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

function loadBaseline(): Set<string> {
  if (!fs.existsSync(BASELINE_FILE)) return new Set();
  return new Set(
    fs
      .readFileSync(BASELINE_FILE, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
}

function main(): void {
  const baseline = loadBaseline();
  const hits: UrlHit[] = [];
  let scanned = 0;
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    scanned++;
    for (const file of walk(abs)) {
      const rel = path.relative(ROOT, file);
      if (isExempt(rel)) continue;
      hits.push(...findUrlValidators(rel, fs.readFileSync(file, "utf8")));
    }
  }
  if (scanned === 0) {
    console.error("URL-validator check: no scan dirs found. Run from repo root.");
    process.exit(1);
  }

  const fresh = hits.filter((h) => !baseline.has(h.key));
  if (fresh.length > 0) {
    console.error("URL-validator violations — use safeUrl (not z.string().url()) for stored/rendered URL fields:\n");
    for (const h of fresh) console.error(`  ${h.key}`);
    console.error(
      "\nImport { safeUrl } from \"@atc/contracts\" and use it for source_url / image_url / *_url fields. " +
        "If this is operator-config (env) validation, it belongs in an env.ts (auto-exempt).",
    );
    process.exit(1);
  }

  console.log(
    `URL-validator check passed: ${hits.length} grandfathered z.string().url() site(s) baselined, 0 new ` +
      "(env.ts config exempt).",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
