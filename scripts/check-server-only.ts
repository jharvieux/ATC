// Server-only leak guard (audit detector) — M9 / audit-service.
//
// Flags importable modules (NOT app/ route|page|layout — those are server-only by
// location and never client-bundled) that read a secret env var or use the
// service-role client but do NOT `import 'server-only'`. Without the poison-pill,
// such a module can be transitively pulled into a Client Component and bundled to
// the browser with no error. The package makes that a BUILD error instead.
//
// Usage:
//   tsx scripts/check-server-only.ts [srcDir]   # default: apps/main/src
//
// AUDIT MODE: exit 0, prints findings (so it can run before the `server-only`
// package + imports are added). Flip `BLOCKING=1` to fail on findings once the
// remediation has landed and a baseline exists.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BLOCKING = process.env.BLOCKING === "1";

// Reads a secret env or constructs the service-role client → server-exclusive.
const SECRET_RE =
  /service-role-client|createServiceRoleClient|SUPABASE_SERVICE_ROLE|SERVICE_ROLE_KEY|STRIPE_SECRET|process\.env\.[A-Z0-9_]*SECRET[A-Z0-9_]*/;
const SERVER_ONLY_RE = /import\s+['"]server-only['"]/;

// Exported for tests — pure decision over (relPath, contents).
export function isServerExclusiveLeakRisk(relPath: string, contents: string): boolean {
  if (!/\.(ts|tsx)$/.test(relPath)) return false;
  // Skip tests/fixtures and server-only-by-location files under app/.
  if (/\.(test|spec)\.|__tests__|\/fixtures\//.test(relPath)) return false;
  // Server-by-execution-context: never imported into a Client Component, so the
  // secret can't reach the browser bundle. app/ (routes/pages/layouts/server
  // components), inngest/ (background jobs), and middleware are entry points, not
  // client-importable modules. The real risk is shared lib/ utilities.
  if (/\/app\/|\/inngest\/|\/middleware\.|\.server\.(ts|tsx)$/.test(relPath)) return false;
  if (/Server\.(ts|tsx)$/.test(relPath)) return false; // server components (RSC-only by convention)
  if (!SECRET_RE.test(contents)) return false;
  return !SERVER_ONLY_RE.test(contents);
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function main(): void {
  const srcDir = path.resolve(process.argv[2] ?? path.join(REPO_ROOT, "apps/main/src"));
  const findings = walk(srcDir)
    .map((abs) => ({ rel: path.relative(REPO_ROOT, abs), abs }))
    .filter(({ rel, abs }) => isServerExclusiveLeakRisk(rel, fs.readFileSync(abs, "utf8")));

  if (findings.length === 0) {
    console.log("server-only guard: ok — every server-exclusive importable module imports 'server-only'.");
    return;
  }

  console.error(
    `server-only guard: ${findings.length} server-exclusive module(s) lack \`import 'server-only'\` ` +
      "(could be transitively bundled to the client):\n",
  );
  for (const f of findings) console.error(`  ${f.rel}`);
  console.error("\n  Fix: add `import 'server-only';` at the top of each (the package makes a client import a build error).");

  if (BLOCKING) process.exit(1);
}

main();
