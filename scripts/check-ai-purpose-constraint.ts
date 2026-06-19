// AI-purpose constraint guard (issue #1271).
//
// Fails if the AICallPurpose union in call-wrapper.ts diverges from the
// ai_call_log_purpose_check CHECK constraint in the latest migration that
// defines it. Root cause of the "AI temporarily unavailable" incident:
// safeAwait throws on any DB error (D-094), so a constraint violation in
// the cost-log insert surfaces to users as an AI outage even though the
// Anthropic call succeeded.
//
// No DB connection required — pure source parse; safe to run in CI.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALL_WRAPPER = path.join(ROOT, "apps/main/src/lib/ai/call-wrapper.ts");
const MIGRATIONS_DIR = path.join(ROOT, "apps/main/supabase/migrations");

export function parseAICallPurposeUnion(src: string): Set<string> {
  const lines = src.split("\n");
  const startIdx = lines.findIndex((l) => /export type AICallPurpose\s*=/.test(l));
  if (startIdx === -1) return new Set();
  const members = new Set<string>();
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/\|\s*"([^"]+)"/);
    if (m) members.add(m[1]);
    // Match only `| "value";` lines — a `";` inside a comment (e.g.
    // `// see "foo";`) must not trigger early exit and drop later members.
    if (/\|\s*"[^"]+";\s*$/.test(line)) break;
  }
  return members;
}

export function parseConstraintValues(sql: string): Set<string> {
  const m = sql.match(
    /ADD CONSTRAINT ai_call_log_purpose_check CHECK \(purpose IN \(([\s\S]*?)\)\)/,
  );
  if (!m) return new Set();
  const values = new Set<string>();
  for (const vm of m[1].matchAll(/'([^']+)'/g)) {
    values.add(vm[1]);
  }
  return values;
}

export function findLatestConstraintValues(migrationsDir: string): Set<string> {
  if (!fs.existsSync(migrationsDir)) return new Set();
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let latest = new Set<string>();
  for (const file of files) {
    const content = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    if (!content.includes("ai_call_log_purpose_check")) continue;
    const values = parseConstraintValues(content);
    if (values.size > 0) latest = values;
  }
  return latest;
}

function main(): void {
  if (!fs.existsSync(CALL_WRAPPER)) {
    console.error(
      `AI-purpose check cannot run: ${path.relative(ROOT, CALL_WRAPPER)} not found. Run from repo root.`,
    );
    process.exit(1);
  }
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(
      `AI-purpose check cannot run: ${path.relative(ROOT, MIGRATIONS_DIR)} not found. Run from repo root.`,
    );
    process.exit(1);
  }

  const wrapperSrc = fs.readFileSync(CALL_WRAPPER, "utf8");
  const unionMembers = parseAICallPurposeUnion(wrapperSrc);
  if (unionMembers.size === 0) {
    console.error(
      "AI-purpose check: 0 members found in AICallPurpose union. Likely a regex mismatch or the type was renamed.",
    );
    process.exit(1);
  }

  const constraintValues = findLatestConstraintValues(MIGRATIONS_DIR);
  if (constraintValues.size === 0) {
    console.error(
      "AI-purpose check: no ai_call_log_purpose_check constraint found in any migration. " +
        "Ensure the migrations directory contains a CHECK constraint definition.",
    );
    process.exit(1);
  }

  const inUnionNotConstraint = [...unionMembers].filter(
    (v) => !constraintValues.has(v),
  );
  const inConstraintNotUnion = [...constraintValues].filter(
    (v) => !unionMembers.has(v),
  );

  if (inUnionNotConstraint.length > 0 || inConstraintNotUnion.length > 0) {
    console.error(
      "AI-purpose constraint drift detected — AICallPurpose union and ai_call_log_purpose_check CHECK diverge:\n",
    );
    if (inUnionNotConstraint.length > 0) {
      console.error(
        "  In AICallPurpose but NOT in constraint (will cause ai_call_log insert failures):",
      );
      for (const v of inUnionNotConstraint) console.error(`    '${v}'`);
    }
    if (inConstraintNotUnion.length > 0) {
      console.error(
        "  In constraint but NOT in AICallPurpose (dead allow-list entries):",
      );
      for (const v of inConstraintNotUnion) console.error(`    '${v}'`);
    }
    console.error(
      "\nAdd a migration to widen the CHECK constraint to match the union.",
    );
    process.exit(1);
  }

  console.log(
    `AI-purpose constraint check passed: ${unionMembers.size} purposes in sync between AICallPurpose union and ai_call_log_purpose_check.`,
  );
}

main();
