// Env-schema completeness guard (Harvey Tier-3, D-091 #28 mechanical half —
// refs #2002, #2004).
//
// Every secret/config var must register in the app's canonical env schema
// (apps/<app>/src/lib/env.ts) at integration time. A raw `process.env.X` read
// of an undeclared identifier bypasses boot validation AND the schema's role
// as the auditable inventory of every secret — which is how
// MAIN_APP_ADMIN_API_KEY became a static, non-rotating, schema-invisible
// bearer (#2002). This guard diffs the identifiers actually read against the
// identifiers declared, per app.
//
// The rotation-path half of D-091 #28 (_CURRENT/_PREVIOUS acceptance on verify
// sites) is reviewer-enforced, not mechanical — stated honestly in
// docs/runbooks/anti-patterns.md #28.
//
// FREEZE-EXISTING / BLOCK-NEW: pre-existing undeclared reads are frozen in
// scripts/env-schema-baseline.txt (count-keyed by <app>::<VAR>). NEW undeclared
// reads fail: declare the var in env.ts (or read it via the env object).
// Fails loud when an env.ts is missing or declares zero keys.
//
// Usage: tsx scripts/check-env-schema-completeness.ts

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = path.join(ROOT, "scripts/env-schema-baseline.txt");
const APPS = ["main", "rag"];

// Schema keys are the z.object literal's property names — uppercase identifiers
// at property position in env.ts (`  STRIPE_SECRET_KEY: z.string()...`).
export function declaredKeys(envTsText: string): Set<string> {
  const keys = new Set<string>();
  for (const m of envTsText.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)) keys.add(m[1]!);
  return keys;
}

const ENV_READ = /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g;

// Node/Next/Vercel runtime vars are platform-provided, not app configuration —
// they have no business in the app's env schema.
const RUNTIME_VARS = new Set(["NODE_ENV", "CI", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_REGION", "NEXT_RUNTIME", "TZ", "PORT"]);

export interface EnvFinding {
  app: string;
  key: string; // <app>::<VAR>
  varName: string;
  file: string;
  line: number;
}

export function findUndeclaredReads(app: string, relPath: string, contents: string, declared: ReadonlySet<string>): EnvFinding[] {
  if (/\.(test|spec)\.|__tests__|\/fixtures\//.test(relPath)) return [];
  const out: EnvFinding[] = [];
  const lines = contents.split("\n");
  lines.forEach((ln, i) => {
    for (const m of ln.matchAll(ENV_READ)) {
      const varName = m[1]!;
      if (declared.has(varName) || RUNTIME_VARS.has(varName)) continue;
      out.push({ app, key: `${app}::${varName}`, varName, file: relPath, line: i + 1 });
    }
  });
  return out;
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

export function loadBaseline(file: string = BASELINE_FILE): Map<string, number> {
  const map = new Map<string, number>();
  if (!fs.existsSync(file)) return map;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
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
  const findings: EnvFinding[] = [];
  for (const app of APPS) {
    const envTs = path.join(ROOT, `apps/${app}/src/lib/env.ts`);
    if (!fs.existsSync(envTs)) {
      console.error(`env-schema guard: apps/${app}/src/lib/env.ts not found — schema moved? Update this guard.`);
      process.exit(1);
    }
    const declared = declaredKeys(fs.readFileSync(envTs, "utf8"));
    if (declared.size === 0) {
      console.error(`env-schema guard: zero declared keys parsed from apps/${app}/src/lib/env.ts — parser regression. Failing loud.`);
      process.exit(1);
    }
    for (const abs of walk(path.join(ROOT, `apps/${app}/src`))) {
      const rel = path.relative(ROOT, abs);
      findings.push(...findUndeclaredReads(app, rel, fs.readFileSync(abs, "utf8"), declared));
    }
  }

  const liveCounts = new Map<string, number>();
  for (const f of findings) liveCounts.set(f.key, (liveCounts.get(f.key) ?? 0) + 1);

  const baseline = loadBaseline();
  const fresh: EnvFinding[] = [];
  const seen = new Map<string, number>();
  for (const f of findings) {
    const n = (seen.get(f.key) ?? 0) + 1;
    seen.set(f.key, n);
    if (n > (baseline.get(f.key) ?? 0)) fresh.push(f);
  }
  const stale = [...baseline].filter(([key, based]) => (liveCounts.get(key) ?? 0) < based);

  if (fresh.length > 0) {
    console.error(
      "env-schema guard: process.env read(s) of identifier(s) NOT declared in the app's env schema" +
        " (apps/<app>/src/lib/env.ts). Declare each var in the schema (with a rotation path if it's" +
        " a secret — D-091 #28) and read it through the env object:\n",
    );
    for (const f of fresh) console.error(`  ${f.file}:${f.line}  process.env.${f.varName}`);
    console.error(`\n${fresh.length} NEW undeclared read(s) beyond scripts/env-schema-baseline.txt.`);
    process.exit(1);
  }
  const note = stale.length > 0 ? ` (${stale.length} stale baseline entr(y/ies) — trim them)` : "";
  console.log(`env-schema guard passed: ${findings.length} pre-existing undeclared read(s) baselined, 0 new${note}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
