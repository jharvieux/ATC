// .next bundle secret scan (#1637) — post-build CI guard.
//
// gitleaks/GitGuardian scan committed SOURCE, not build OUTPUT. A service-role
// Supabase JWT accidentally referenced under a NEXT_PUBLIC_ name (or hardcoded)
// would be inlined into the client bundle and shipped to every browser. This
// scans the built .next output for JWT-shaped strings, DECODES the payload, and
// fails only if the `role` claim is `service_role`.
//
// Decode-don't-pattern-match: the Supabase ANON key is also a JWT and is
// SUPPOSED to be in the bundle (role "anon"). A raw JWT-shape regex would
// false-positive on every anon-key-carrying bundle, so we inspect the claim.
//
// Runs after `pnpm -r build` in CI (needs the built output; not in pnpm verify).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIRS = ["apps/main/.next", "apps/rag/.next"];

// Three base64url segments — the JWT shape. Supabase keys always start `eyJ`.
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

function decodeRole(jwt: string): string | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const claims = JSON.parse(json) as { role?: unknown };
    return typeof claims.role === "string" ? claims.role : null;
  } catch {
    return null; // not a decodable JWT payload — ignore.
  }
}

export interface Leak {
  file: string; // repo-relative
  role: string;
}

// Exported for tests — pure decision over (relPath, contents).
export function findServiceRoleLeaks(relPath: string, contents: string): Leak[] {
  const out: Leak[] = [];
  const seen = new Set<string>();
  for (const m of contents.matchAll(JWT_RE)) {
    const jwt = m[0];
    if (seen.has(jwt)) continue;
    seen.add(jwt);
    const role = decodeRole(jwt);
    if (role === "service_role") out.push({ file: relPath, role });
  }
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "cache") continue; // build cache, not shipped
      out.push(...walk(p));
    } else if (/\.(js|json|txt|html|map)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

function main(): void {
  const argDirs = process.argv.slice(2);
  const dirs = argDirs.length > 0 ? argDirs : DEFAULT_DIRS;
  const leaks: Leak[] = [];
  let scanned = 0;
  for (const dir of dirs) {
    const abs = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    scanned++;
    for (const file of walk(abs)) {
      leaks.push(...findServiceRoleLeaks(path.relative(ROOT, file), fs.readFileSync(file, "utf8")));
    }
  }
  if (scanned === 0) {
    console.error("Bundle secret scan: no .next dir found. Run after `pnpm -r build`.");
    process.exit(1);
  }
  if (leaks.length > 0) {
    console.error("Bundle secret scan: SERVICE_ROLE JWT found in client build output:\n");
    for (const l of leaks) console.error(`  ${l.file}: role=${l.role}`);
    console.error("\nA service_role key must NEVER reach the client bundle. Remove it and rotate the key.");
    process.exit(1);
  }
  console.log(`Bundle secret scan passed: ${scanned} build dir(s) scanned, no service_role JWT in output.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
