// Policy-migration ↔ RLS-snapshot consistency gate (#1492).
//
// Closes the gap that left db/rls-snapshot-main.sql stale after #1486: a
// migration changed RLS policies but its PR never regenerated the committed
// snapshot. The DB-based `rls-snapshot-diff` job (#1488) is the authoritative
// backstop, but it needs the test DB and only runs when SUPABASE_TEST_DB_URL is
// present. This is the cheap, DB-free, author-facing early-catch: if a migration
// in the PR diff contains CREATE/ALTER/DROP POLICY, the matching
// db/rls-snapshot-<app>.sql must be changed in the SAME diff.
//
// Scope: RLS policies only. Grants drift is covered by the DB-based grants:check
// (a static keyword guard can't see the default ACLs a bare CREATE TABLE grants,
// so it would be both noisy and incomplete — wrong tool).
//
// Usage:
//   tsx scripts/check-policy-snapshot.ts              # diff origin/dev...HEAD
//   POLICY_SNAPSHOT_BASE_REF=origin/release/x tsx scripts/check-policy-snapshot.ts
//
// Exit 0 if consistent (or nothing to check). Exit 1 on a violation. A git-diff
// failure (e.g. base ref not fetched) is a warning + exit 0 — never block a PR on
// CI plumbing; the DB-based check still gates.
//
// Escape hatch: an inline `-- snapshot-guard-allow:<reason>` comment in the
// migration suppresses the check for that file (for a policy change that nets no
// snapshot delta — e.g. a DROP+identical-CREATE rewrite).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_REF = process.env.POLICY_SNAPSHOT_BASE_REF ?? "origin/dev";

const MIGRATION_RE = /^apps\/(main|rag)\/supabase\/migrations\/.+\.sql$/;
const POLICY_DDL_RE = /\b(?:CREATE|ALTER|DROP)\s+POLICY\b/i;
const SUPPRESS_RE = /--\s*snapshot-guard-allow:\s*\S+/i;

export interface Violation {
  migration: string;
  app: "main" | "rag";
  snapshot: string;
}

// Strip SQL comments so a policy keyword inside a comment (e.g. an explanatory
// "-- this does not CREATE POLICY x") doesn't trip the DDL match.
export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/--[^\n]*/g, " "); // line comments
}

// Pure core: given the set of changed paths and a file reader, return the
// migrations that changed policies without a matching snapshot change.
export function analyze(
  changedFiles: string[],
  readFile: (relPath: string) => string,
): Violation[] {
  const changed = new Set(changedFiles);
  const violations: Violation[] = [];

  for (const file of changedFiles) {
    const m = file.match(MIGRATION_RE);
    if (!m) continue;
    const app = m[1] as "main" | "rag";

    let content: string;
    try {
      content = readFile(file);
    } catch {
      continue; // deleted or unreadable — not our concern
    }

    if (SUPPRESS_RE.test(content)) continue;
    if (!POLICY_DDL_RE.test(stripSqlComments(content))) continue;

    const snapshot = `db/rls-snapshot-${app}.sql`;
    if (!changed.has(snapshot)) {
      violations.push({ migration: file, app, snapshot });
    }
  }

  return violations;
}

function changedFiles(): { files: string[]; ok: boolean } {
  try {
    const out = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=AMR", `${BASE_REF}...HEAD`],
      { encoding: "utf8", cwd: REPO_ROOT },
    );
    return { files: out.split("\n").map((l) => l.trim()).filter(Boolean), ok: true };
  } catch {
    return { files: [], ok: false };
  }
}

function main(): void {
  const { files, ok } = changedFiles();
  if (!ok) {
    console.warn(
      `policy-snapshot guard: could not compute 'git diff ${BASE_REF}...HEAD' — ` +
        "skipping (the DB-based rls-snapshot-diff check still gates).",
    );
    return;
  }

  const violations = analyze(files, (rel) =>
    fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"),
  );

  if (violations.length === 0) {
    console.log("policy-snapshot guard: ok — no policy migration is missing its snapshot.");
    return;
  }

  console.error("policy-snapshot guard: RLS snapshot not regenerated for a policy migration.\n");
  for (const v of violations) {
    console.error(
      `  ${v.migration}\n` +
        `    changes RLS policies but ${v.snapshot} is unchanged in this PR.\n` +
        `    Fix: pnpm rls:snapshot:${v.app}  (then commit ${v.snapshot})\n` +
        `    Or, if the policy change nets no snapshot delta, add an inline\n` +
        `    '-- snapshot-guard-allow:<reason>' comment to the migration.\n`,
    );
  }
  process.exit(1);
}

main();
