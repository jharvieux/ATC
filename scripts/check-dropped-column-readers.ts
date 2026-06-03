// Dropped-column-reader gate (orchestrator).
//
// Fails the build when application code still reads a column from the table
// a migration dropped it from. See scripts/lib/dropped-column-readers.ts for
// the WHY (BP38/#137) and the table-aware matching logic. This file is just
// the I/O shell: gather migrations + sources from disk, run the pure logic,
// report, exit non-zero on any violation.

import fs from "node:fs";
import path from "node:path";
import {
  parseColumnOps,
  computeRemovedColumns,
  findViolations,
  parseExceptions,
  type Migration,
  type SourceFile,
} from "./lib/dropped-column-readers";

const APPS_DIR = "apps";
const EXCEPTIONS_FILE = path.join("db", "dropped-column-exceptions.txt");
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
  const removed = computeRemovedColumns(parseColumnOps(migrations));
  const droppedCount = [...removed.values()].reduce((n, s) => n + s.size, 0);

  const sources = readSources();
  const exceptions = readExceptions();
  const violations = findViolations(removed, sources).filter(
    (v) => !exceptions.has(`${v.table}.${v.column}`),
  );

  if (violations.length > 0) {
    console.error("Dropped-column reader violations:\n");
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`    reads dropped column ${v.table}.${v.column} — ${v.snippet}`);
    }
    console.error(
      `\n${violations.length} reader(s) reference a column a migration dropped from that table.`,
    );
    console.error(
      "Switch the reader to the column's new location, or — if this is a deliberate, justified",
    );
    console.error(`reference — add \`${"<table>.<column>"} # reason\` to ${EXCEPTIONS_FILE}.`);
    process.exit(1);
  }

  console.log(
    `Dropped-column reader check passed: scanned ${sources.length} source file(s) against ` +
      `${droppedCount} dropped column(s) across ${removed.size} table(s).`,
  );
}

main();
