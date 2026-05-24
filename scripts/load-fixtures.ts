// BP30 §30.4 — fixture loader CLI.
//
// Applies test-data/fixtures/*.sql files in lexicographic order against
// SUPABASE_DB_URL, then verifies row counts match
// test-data/fixtures/EXPECTED_COUNTS.md. Tables marked "(TODO)" in the
// expected-counts file are skipped (logged as informational).
//
// Usage:
//   SUPABASE_DB_URL=postgres://... tsx scripts/load-fixtures.ts
//   tsx scripts/load-fixtures.ts --dry-run    # parse + enumerate, no DB
//
// Exit codes:
//   0 — loaded successfully and all assertions match
//   1 — load failed OR a non-TODO row count mismatched
//   2 — invalid EXPECTED_COUNTS.md format
//   3 — SUPABASE_DB_URL missing in non-dry-run mode

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import postgres from "postgres";

const FIXTURES_DIR = resolve(__dirname, "..", "test-data", "fixtures");
const EXPECTED_COUNTS_PATH = join(FIXTURES_DIR, "EXPECTED_COUNTS.md");

interface ExpectedCount {
  table: string;
  expected: number;
  todo: boolean;
}

interface LoadResult {
  filesApplied: string[];
  mismatches: Array<{ table: string; expected: number; actual: number }>;
}

export function parseExpectedCounts(raw: string): ExpectedCount[] {
  const entries: ExpectedCount[] = [];
  const seen = new Set<string>();
  // Pull entries from any fenced-code block: `tablename: N` or
  // `tablename: N (TODO ...)` — trailing `# comment` allowed.
  const lineRe = /^([a-z][a-z0-9_]*)\s*:\s*(\d+)(\s*\(TODO[^)]*\))?(\s*#.*)?\s*$/;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("```") || t.startsWith("-")) continue;
    const m = t.match(lineRe);
    if (!m) continue;
    const table = m[1]!;
    const expected = parseInt(m[2]!, 10);
    const todo = !!m[3];
    if (seen.has(table)) {
      throw new Error(
        `EXPECTED_COUNTS.md: duplicate entry for table '${table}'. Each table must appear once.`,
      );
    }
    seen.add(table);
    entries.push({ table, expected, todo });
  }
  if (entries.length === 0) {
    throw new Error(
      `EXPECTED_COUNTS.md: no parseable 'tablename: N' lines found. ` +
        `Each entry must look like 'tier_definitions: 6' inside a code fence.`,
    );
  }
  return entries;
}

export function enumerateFixtureFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => join(dir, f));
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const expectedRaw = readFileSync(EXPECTED_COUNTS_PATH, "utf8");
  const expected = parseExpectedCounts(expectedRaw);
  const files = enumerateFixtureFiles(FIXTURES_DIR);

  console.log(`[load-fixtures] ${files.length} fixture file(s) found.`);
  console.log(`[load-fixtures] ${expected.length} expected-count entries.`);
  for (const e of expected) {
    const marker = e.todo ? " (TODO — assertion skipped)" : "";
    console.log(`  - ${e.table}: ${e.expected}${marker}`);
  }

  if (dryRun) {
    console.log("[load-fixtures] --dry-run: skipping DB apply.");
    process.exit(0);
  }

  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.error(
      "Error: SUPABASE_DB_URL is required for the loader. " +
        "In CI use the SUPABASE_TEST_DB_URL secret. " +
        "Pass --dry-run to validate file structure without a DB.",
    );
    process.exit(3);
  }

  const sql = postgres(dbUrl, { max: 1, idle_timeout: 10 });
  const result: LoadResult = { filesApplied: [], mismatches: [] };

  try {
    for (const file of files) {
      const sqlText = readFileSync(file, "utf8");
      // Skip files that have no SQL statements (header-only stubs).
      const hasStatements = /^\s*(?:INSERT|UPDATE|DELETE|WITH|SELECT)\s/im.test(sqlText);
      if (!hasStatements) {
        console.log(`[load-fixtures] ${file.split("/").pop()} — header-only stub, skipping apply`);
        result.filesApplied.push(`${file.split("/").pop()} (no-op)`);
        continue;
      }
      console.log(`[load-fixtures] applying ${file.split("/").pop()}…`);
      await sql.unsafe(sqlText);
      result.filesApplied.push(file.split("/").pop() ?? file);
    }

    // Assert counts on non-TODO entries.
    for (const e of expected) {
      if (e.todo) continue;
      const rows = await sql.unsafe(
        `SELECT COUNT(*)::int AS n FROM public.${e.table}`,
      );
      const actual = (rows[0] as { n: number } | undefined)?.n ?? 0;
      if (actual !== e.expected) {
        result.mismatches.push({ table: e.table, expected: e.expected, actual });
      } else {
        console.log(`[load-fixtures] ✓ public.${e.table}: ${actual} rows (matches expected)`);
      }
    }

    if (result.mismatches.length > 0) {
      console.error(`\n[load-fixtures] FAILED — row-count mismatches:`);
      for (const m of result.mismatches) {
        console.error(
          `  - public.${m.table}: expected ${m.expected}, got ${m.actual}`,
        );
      }
      console.error(
        `\nEither (a) the fixture didn't insert what EXPECTED_COUNTS.md claims, or ` +
          `(b) EXPECTED_COUNTS.md is stale and needs updating.`,
      );
      process.exit(1);
    }

    console.log(`\n[load-fixtures] OK — applied ${result.filesApplied.length} files, all counts match.`);
    process.exit(0);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Only run main when invoked as a script (not when imported by tests).
if (require.main === module) {
  main().catch((err) => {
    console.error("[load-fixtures] crashed:", err);
    process.exit(1);
  });
}
