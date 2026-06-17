// Permission-matrix guard (issue #1176).
//
// Fails if any assertPermission(req, { resource: "X", action: "Y" }) call in
// apps/main/src/app/api/** is absent from the RBAC grant matrix
// (permission-grants.ts). Prevents the silent hard-403 class caused when a
// route is gated by assertPermission but the corresponding (resource, action)
// pair is never added to the grants file (root cause of #1173 and its
// instances).
//
// tsc cannot see this gap — resource/action are plain strings. The E2E tests
// bypass permission checks via role='tenant_owner', so they never exercise
// isPermitted(). Only this static sweep catches it mechanically.
//
// BASELINE: scripts/permission-matrix-baseline.txt lists known pre-existing
// gaps tracked in issue #1173. The check fails on NEW gaps only. Remove a
// baseline entry once the corresponding grant is added to permission-grants.ts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = path.join(ROOT, "apps/main/src/app/api");
const GRANTS_FILE = path.join(ROOT, "apps/main/src/lib/auth/permission-grants.ts");
const BASELINE_FILE = path.join(ROOT, "scripts/permission-matrix-baseline.txt");

// Matches assertPermission(req, { resource: "X", action: "Y" }) in either
// property order. Two passes per call site: resource-first and action-first.
// The codebase currently uses resource-first everywhere, but the dual-pass
// makes the check order-independent so a future caller can't silently evade
// it by writing { action: "Y", resource: "X" }.
export const ASSERT_RESOURCE_FIRST =
  /assertPermission\([^{]*\{\s*[^}]*resource:\s*"([^"]+)"[^}]*action:\s*"([^"]+)"/g;
export const ASSERT_ACTION_FIRST =
  /assertPermission\([^{]*\{\s*[^}]*action:\s*"([^"]+)"[^}]*resource:\s*"([^"]+)"/g;

// Matches: key("resource", "action") in permission-grants.ts
export const KEY_RE = /key\("([^"]+)",\s*"([^"]+)"\)/g;

/**
 * Extract all (resource, action) pairs from route file content.
 * Handles both resource-first and action-first property ordering.
 */
export function extractAssertedPairs(content: string): Set<string> {
  const pairs = new Set<string>();
  for (const m of content.matchAll(new RegExp(ASSERT_RESOURCE_FIRST.source, "g"))) {
    pairs.add(`${m[1]}:${m[2]}`);
  }
  for (const m of content.matchAll(new RegExp(ASSERT_ACTION_FIRST.source, "g"))) {
    pairs.add(`${m[2]}:${m[1]}`);
  }
  return pairs;
}

/**
 * Extract all granted (resource, action) pairs from permission-grants.ts content.
 */
export function extractGrantedPairs(content: string): Set<string> {
  const pairs = new Set<string>();
  for (const m of content.matchAll(new RegExp(KEY_RE.source, "g"))) {
    pairs.add(`${m[1]}:${m[2]}`);
  }
  return pairs;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  const SKIP = new Set(["node_modules", ".next", "dist", "build", "coverage"]);
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(path.join(d, entry.name));
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(path.join(d, entry.name));
      }
    }
  };
  walk(dir);
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
  if (!fs.existsSync(API_DIR) || !fs.existsSync(GRANTS_FILE)) {
    console.error(
      `Permission-matrix check cannot run: missing "${path.relative(ROOT, API_DIR)}" or "${path.relative(ROOT, GRANTS_FILE)}". Run from repo root.`,
    );
    process.exit(1);
  }

  const grantsContent = fs.readFileSync(GRANTS_FILE, "utf8");
  const granted = extractGrantedPairs(grantsContent);
  if (granted.size === 0) {
    console.error(
      `Permission-matrix check: 0 granted pairs found in ${path.relative(ROOT, GRANTS_FILE)}. Likely a regex mismatch or empty file.`,
    );
    process.exit(1);
  }

  const baseline = loadBaseline();

  const apiFiles = walkTs(API_DIR);
  if (apiFiles.length === 0) {
    console.error(
      `Permission-matrix check: 0 files found under ${path.relative(ROOT, API_DIR)}. Run from repo root.`,
    );
    process.exit(1);
  }

  const missing: { file: string; pair: string }[] = [];
  for (const file of apiFiles) {
    const content = fs.readFileSync(file, "utf8");
    for (const pair of extractAssertedPairs(content)) {
      if (!granted.has(pair) && !baseline.has(pair)) {
        missing.push({ file: path.relative(ROOT, file), pair });
      }
    }
  }

  if (missing.length > 0) {
    console.error(
      "Permission-matrix violations — assertPermission pairs absent from RBAC grant matrix:\n",
    );
    const byPair = new Map<string, string[]>();
    for (const { file, pair } of missing) {
      (byPair.get(pair) ?? byPair.set(pair, []).get(pair)!).push(file);
    }
    for (const [pair, files] of byPair) {
      console.error(`  missing grant: ${pair}`);
      for (const f of files) console.error(`    ${f}`);
    }
    console.error(
      `\n${byPair.size} pair(s) gated by assertPermission but absent from permission-grants.ts and not in baseline.`,
    );
    console.error(
      "Add them to READ_GRANTS / AGENT_GRANTS / OWNER_GRANTS and to the unit-test matrix in permission-grants.test.ts.",
    );
    console.error(
      "See CLAUDE.md: 'Permission grants belong with the route PR'.",
    );
    process.exit(1);
  }

  const baselineCount = baseline.size;
  console.log(
    `Permission-matrix check passed: ${apiFiles.length} route file(s) scanned, ` +
      `all non-baselined assertPermission pairs present in ${granted.size} granted pairs` +
      (baselineCount > 0 ? ` (${baselineCount} pre-existing gap(s) tracked in baseline — see issue #1173)` : "") +
      ".",
  );
}

main();
