// Ambiguous PostgREST embed gate (orchestrator).
//
// Fails the build when application code uses a PostgREST FK embed
// (.select("related_table(cols)")) where the base table has multiple FK
// relationships to the referenced table and no disambiguation hint is present.
//
// PostgREST resolves ambiguous embeds arbitrarily (or errors); the fix is to
// add a `!constraint_name` hint. `!inner` and `!left` are JOIN MODIFIERS,
// not disambiguation — they do not resolve ambiguity.
//
// Incident: issue #1134 — two FKs from contact_relationships to contacts
// made embeds unpredictable.
//
// See scripts/lib/embed-fk-graph.ts for the pure detection logic.

import fs from "node:fs";
import path from "node:path";
import {
  parseFKRelationships,
  buildAmbiguityMap,
  findViolations,
  type Migration,
  type SourceFile,
} from "./lib/embed-fk-graph";

const APPS_DIR = "apps";
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

function main(): void {
  const migrations = readMigrations();
  const sources = readSources();

  if (migrations.length === 0 || sources.length === 0) {
    console.error(
      `Ambiguous-embed check could not run: found ${migrations.length} migration(s) ` +
        `and ${sources.length} source file(s) under ${APPS_DIR}/. Run from the repo root.`,
    );
    process.exit(1);
  }

  const fks = parseFKRelationships(migrations);
  const ambiguityMap = buildAmbiguityMap(fks);

  // Count ambiguous table pairs (≥2 FKs between same pair)
  let ambiguousPairs = 0;
  for (const inner of ambiguityMap.values()) {
    for (const constraints of inner.values()) {
      if (constraints.length >= 2) ambiguousPairs++;
    }
  }

  const violations = findViolations(ambiguityMap, sources);

  if (violations.length > 0) {
    console.error("Ambiguous PostgREST embed violations:\n");
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(
        `    .from("${v.baseTable}") → ambiguous embed "${v.embeddedTable}" (${v.knownConstraints.length} FK paths)`,
      );
      console.error(`    Fix: add !constraint_name hint, e.g. "${v.embeddedTable}!${v.knownConstraints[0]}(...)"`);
      console.error(`    Known FK constraints: ${v.knownConstraints.join(", ")}`);
      console.error(`    ${v.snippet}`);
      console.error("");
    }
    console.error(
      `${violations.length} embed(s) are ambiguous — PostgREST picks FK arbitrarily.`,
    );
    console.error(
      "Add a !constraint_name hint to the embedded table name in the .select() string.",
    );
    console.error(
      "Note: !inner and !left are join-type modifiers, not disambiguation hints.",
    );
    process.exit(1);
  }

  console.log(
    `Ambiguous-embed check passed: scanned ${sources.length} source file(s) against ` +
      `${ambiguousPairs} ambiguous FK pair(s) across ${ambiguityMap.size} base table(s).`,
  );
}

main();
