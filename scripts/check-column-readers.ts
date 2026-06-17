// Static-column reader gate (orchestrator).
//
// Fails the build when application code reads a column from a table that never
// had that column (as determined by parsing CREATE TABLE + ALTER TABLE ops from
// all migrations). Companion to check-dropped-column-readers.ts which catches
// columns that were DROPPED; this catches columns that were NEVER present.
// See scripts/lib/column-readers.ts for the matching logic.
//
// Root cause: issue #1183 (tenants.tier, which doesn't exist — tier is a FK
// to tier_definitions; tenant_type="byo_host" reaches code reading .tier and
// throws at runtime, not compile time, because Supabase JS column names are
// plain strings).

import fs from "node:fs";
import path from "node:path";
import {
  computeLiveColumns,
  findSelectViolations,
  parseExceptions,
  type Migration,
  type SourceFile,
} from "./lib/column-readers";

const APPS_DIR = "apps";
const EXCEPTIONS_FILE = path.join("db", "column-reader-exceptions.txt");
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "coverage", ".turbo"]);

function readMigrations(): Migration[] {
  const out: Migration[] = [];
  if (!fs.existsSync(APPS_DIR)) return out;
  for (const app of fs.readdirSync(APPS_DIR)) {
    const dir = path.join(APPS_DIR, app, "supabase", "migrations");
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
      out.push({ file: path.join(dir, f), content: fs.readFileSync(path.join(dir, f), "utf8") });
    }
  }
  return out;
}

function readSources(): SourceFile[] {
  const out: SourceFile[] = [];
  if (!fs.existsSync(APPS_DIR)) return out;
  const roots = fs
    .readdirSync(APPS_DIR)
    .map((app) => path.join(APPS_DIR, app, "src"))
    .filter((d) => fs.existsSync(d));

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        const file = path.join(dir, entry.name);
        out.push({ file, content: fs.readFileSync(file, "utf8") });
      }
    }
  };
  for (const root of roots) walk(root);
  return out;
}

function readExceptions(): Set<string> {
  if (!fs.existsSync(EXCEPTIONS_FILE)) return new Set();
  return parseExceptions(fs.readFileSync(EXCEPTIONS_FILE, "utf8"));
}

function main(): void {
  const migrations = readMigrations();
  const sources = readSources();

  if (migrations.length === 0 || sources.length === 0) {
    console.error(
      `Column reader check could not run: found ${migrations.length} migration(s) ` +
        `and ${sources.length} source file(s) under ${APPS_DIR}/. Run from the repo root.`,
    );
    process.exit(1);
  }

  const live = computeLiveColumns(migrations);
  const tableCount = live.size;
  const exceptions = readExceptions();
  const violations = findSelectViolations(live, sources).filter(
    (v) => !exceptions.has(`${v.table}.${v.column}`),
  );

  if (violations.length > 0) {
    console.error("Static-column reader violations:\n");
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`    reads non-existent column ${v.table}.${v.column} — ${v.snippet}`);
    }
    console.error(
      `\n${violations.length} reader(s) reference a column that is absent from that table's schema.`,
    );
    console.error(
      "Fix the column name, or — if this is a deliberate, justified reference (e.g. a view or",
    );
    console.error(
      `non-public schema) — add \`${"<table>.<column>"} # reason\` to ${EXCEPTIONS_FILE}.`,
    );
    process.exit(1);
  }

  console.log(
    `Column reader check passed: scanned ${sources.length} source file(s) against ` +
      `${tableCount} table schema(s) from ${migrations.length} migration(s).`,
  );
}

main();
