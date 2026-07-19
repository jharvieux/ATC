// Background-job service-role tenant-predicate guard (Harvey Tier-3 — refs #2003).
//
// The existing service-role enforcement has two layers: the eslint import
// allowlist (packages/config/eslint-rules/service-role-allowlist.js — WHO may
// construct the client) and check-d091-anti-patterns.ts's service-role-tenant
// detector (filtered .from() without .eq("tenant_id")). The d091 detector
// exempts every table listed in db/rls-exceptions.txt as "platform-scoped" —
// but several of those tables DO carry a tenant_id column (their RLS is
// service-role-only, which is exactly why the app-layer predicate is the ONLY
// isolation layer left). That exemption is how #2003 escaped: import-pipeline's
// service-role read of gmail_inbound_messages keyed by message_id, no tenant
// predicate, invisible to the gate.
//
// This guard closes exactly that gap for the background-job dirs
// (apps/*/src/inngest, apps/*/src/lib/cron — the highest-blast-radius
// service-role callers): it watches ONLY the intersection the d091 detector
// exempts — tables in its platform set (db/rls-exceptions.txt + extras,
// imported from check-d091-anti-patterns.ts so the two stay in lockstep) that
// nevertheless carry a tenant_id column (derived from the migrations
// themselves — static parse, no DB). Non-platform tables stay the d091
// detector's territory; covering them here too would double-freeze ~80 sites
// across two baselines. A filtered service-role read of a watched table needs
// a tenant predicate or the existing `d091-allow:service-role-tenant <reason>`
// annotation.
//
// Cross-tenant sweeps (a cron scanning every tenant) stay out of scope the same
// way the d091 detector keeps them out: only statements that already carry a
// row filter (.eq/.in/.match) are eligible — the bug shape is "filtered by some
// id but NOT tenant-scoped", not "deliberate full-table scan".
//
// FREEZE-EXISTING / BLOCK-NEW: pre-existing hits frozen in
// scripts/job-service-role-tenant-baseline.txt (count-keyed by file::table).
// Fails loud when zero job files or zero tenant-bearing tables are found.
//
// Usage: tsx scripts/check-job-service-role-tenant.ts

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { platformTables } from "./check-d091-anti-patterns";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = path.join(ROOT, "scripts/job-service-role-tenant-baseline.txt");

// --- tenant-bearing table derivation (static migration parse) ----------------

const CREATE_TABLE = /create table\s+(?:if not exists\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?\s*\(([\s\S]*?)\n\s*\);/gi;
const ALTER_ADD_TENANT =
  /\balter\s+table\s+(?:only\s+)?(?:"?\w+"?\.)?"?(\w+)"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"?tenant_id"?\s/gi;
const TENANT_COLUMN_LINE = /[(,\n]\s*"?tenant_id"?\s+\w/i;

export function tenantBearingTables(allSql: string): Set<string> {
  const clean = allSql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  const tables = new Set<string>();
  for (const m of clean.matchAll(CREATE_TABLE)) {
    if (TENANT_COLUMN_LINE.test(m[3]!)) tables.add(m[2]!.toLowerCase());
  }
  for (const m of clean.matchAll(ALTER_ADD_TENANT)) tables.add(m[1]!.toLowerCase());
  return tables;
}

// --- job-file scan (same statement-window doctrine as check-d091) ------------

const SERVICE_ROLE_GATE = /createServiceRoleClient|SUPABASE_SERVICE_ROLE_KEY|serviceRoleClient|:\s*SupabaseClient\b/;
const FROM_RE = /\.from\(\s*['"`]([a-z0-9_]+)['"`]\s*\)/i;
const HAS_FILTER = /\.(eq|in|match)\(/;
const HAS_TENANT_PREDICATE = /\.(eq|in)\(\s*['"`]tenant_id['"`]/;
const HAS_TENANT_MATCH = /\.match\(\s*\{[^}]*\btenant_id\b/;

function isInlineAllowed(lines: string[], idx: number): boolean {
  const tokens = ["d091-allow:service-role-tenant", "d091-allow:all"];
  if (tokens.some((t) => (lines[idx] ?? "").includes(t))) return true;
  for (let j = idx - 1; j >= 0; j -= 1) {
    const prev = lines[j] ?? "";
    if (prev.trim() === "") continue;
    return tokens.some((t) => prev.includes(t));
  }
  return false;
}

export interface JobFinding {
  file: string;
  key: string; // <file>::<table>
  table: string;
  line: number;
}

export function findUnscopedJobReads(relPath: string, contents: string, tenantTables: ReadonlySet<string>): JobFinding[] {
  if (/\.(test|spec)\.|__tests__|\/fixtures\//.test(relPath)) return [];
  if (!SERVICE_ROLE_GATE.test(contents)) return [];
  const lines = contents.split("\n");
  const out: JobFinding[] = [];
  lines.forEach((ln, i) => {
    const m = FROM_RE.exec(ln);
    if (!m) return;
    const table = m[1]!.toLowerCase();
    if (!tenantTables.has(table)) return;
    // Statement window: this line to the first ';' or blank line (12-line cap —
    // the same window check-d091 uses; deeper payloads aren't this shape).
    const chunk: string[] = [];
    for (let j = i; j < lines.length && j < i + 12; j += 1) {
      chunk.push(lines[j] ?? "");
      if ((lines[j] ?? "").includes(";")) break;
      if (j > i && (lines[j] ?? "").trim() === "") break;
    }
    const stmt = chunk.join("\n");
    if (!HAS_FILTER.test(stmt)) return; // deliberate cross-tenant sweep — out of scope
    if (HAS_TENANT_PREDICATE.test(stmt) || HAS_TENANT_MATCH.test(stmt)) return;
    if (isInlineAllowed(lines, i)) return;
    out.push({ file: relPath, key: `${relPath}::${table}`, table, line: i + 1 });
  });
  return out;
}

// --- plumbing ----------------------------------------------------------------

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

function jobDirs(): string[] {
  const dirs: string[] = [];
  for (const app of fs.readdirSync(path.join(ROOT, "apps"), { withFileTypes: true }).filter((e) => e.isDirectory())) {
    dirs.push(path.join(ROOT, "apps", app.name, "src/inngest"));
    dirs.push(path.join(ROOT, "apps", app.name, "src/lib/cron"));
  }
  return dirs.filter((d) => fs.existsSync(d));
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
  const migrationSql = fs
    .readdirSync(path.join(ROOT, "apps"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(ROOT, "apps", e.name, "supabase/migrations"))
    .filter((d) => fs.existsSync(d))
    .flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith(".sql")).sort().map((f) => fs.readFileSync(path.join(d, f), "utf8")))
    .join("\n\n");
  const tenantBearing = tenantBearingTables(migrationSql);
  if (tenantBearing.size === 0) {
    console.error("job-service-role-tenant guard: derived ZERO tenant-bearing tables from migrations — parser regression. Failing loud.");
    process.exit(1);
  }
  // The watched set = the d091 detector's blind spot: platform-exempted tables
  // that actually carry tenant_id (#2003's gmail_inbound_messages shape).
  const tenantTables = new Set([...platformTables()].filter((t) => tenantBearing.has(t)));
  if (tenantTables.size === 0) {
    console.error("job-service-role-tenant guard: watched-set intersection is EMPTY — rls-exceptions moved? Failing loud.");
    process.exit(1);
  }

  const files = jobDirs().flatMap(walk);
  if (files.length === 0) {
    console.error("job-service-role-tenant guard: no files found under job dirs — check paths.");
    process.exit(1);
  }

  const findings = files.flatMap((abs) => findUnscopedJobReads(path.relative(ROOT, abs), fs.readFileSync(abs, "utf8"), tenantTables));
  const liveCounts = new Map<string, number>();
  for (const f of findings) liveCounts.set(f.key, (liveCounts.get(f.key) ?? 0) + 1);

  const baseline = loadBaseline();
  const fresh: JobFinding[] = [];
  const seen = new Map<string, number>();
  for (const f of findings) {
    const n = (seen.get(f.key) ?? 0) + 1;
    seen.set(f.key, n);
    if (n > (baseline.get(f.key) ?? 0)) fresh.push(f);
  }
  const stale = [...baseline].filter(([key, based]) => (liveCounts.get(key) ?? 0) < based);

  if (fresh.length > 0) {
    console.error(
      "job-service-role-tenant guard: filtered service-role read(s) of a tenant_id-bearing table" +
        " in a background job with NO tenant predicate. Add .eq(\"tenant_id\", …) (or annotate a" +
        " reviewed site with `d091-allow:service-role-tenant <reason>`):\n",
    );
    for (const f of fresh) console.error(`  ${f.file}:${f.line}  .from("${f.table}")`);
    console.error(`\n${fresh.length} NEW finding(s) beyond scripts/job-service-role-tenant-baseline.txt.`);
    process.exit(1);
  }
  const note = stale.length > 0 ? ` (${stale.length} stale baseline entr(y/ies) — trim them)` : "";
  console.log(
    `job-service-role-tenant guard passed: ${files.length} job file(s), ${tenantTables.size} tenant-bearing table(s), ${findings.length} baselined finding(s), 0 new${note}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
