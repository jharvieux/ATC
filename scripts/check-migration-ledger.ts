// Migration-ledger collision pre-check (#1660) — the DB-based backstop for
// scripts/check-migration-collision.ts (DB-free, diffs against origin/dev's
// FILE TREE). This script diffs against the shared TEST DB's actual applied
// ledger, which is the thing that really gets corrupted: two branches that
// have never been diffed against each other (e.g. both cut before either
// merged) can each pass the DB-free check yet still race for the same
// version — whichever's `supabase db push` lands first in CI wins the ledger
// row; the loser's push then either silently no-ops (if content matches by
// luck) or, per the #1660 incident, corrupts the shared ledger for every
// subsequent PR.
//
// Runs in deploy.yml's rls-snapshot-diff job, BEFORE `supabase db push`:
// for every migration file this branch ADDS, look up its version in
// supabase_migrations.schema_migrations. If a ledger row already exists for
// that version with a DIFFERENT name (slug) than the branch's file, some
// other already-merged migration already claimed this version — fail loudly
// with a remediation pointer to scripts/new-migration.sh, before the push
// can corrupt the ledger further.
//
// Usage:
//   tsx scripts/check-migration-ledger.ts --target=main
//   tsx scripts/check-migration-ledger.ts --target=rag
//   MIGRATION_LEDGER_BASE_REF=origin/release/x tsx scripts/check-migration-ledger.ts --target=main
//
// Env: SUPABASE_DB_URL (main) / SUPABASE_RAG_DB_URL (rag) — same vars used by
// rls-snapshot.ts. Missing var SKIPS (exit 0) — same posture as rls:check's
// RLS_ALLOW_NO_TARGETS: a secret-less run (Dependabot) can't check anything,
// and blocking it would be a false failure, not a caught collision.
//
// Exit 0 if no collision (or nothing to check, or DB unreachable — logged as
// a warning, since a flaky test DB shouldn't block every PR; this is a
// pre-check ahead of `supabase db push`, which will itself fail loudly on a
// real ledger conflict). Exit 1 on a confirmed collision.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { redactSecrets } from "./lib/redact-secrets";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_REF = process.env.MIGRATION_LEDGER_BASE_REF ?? "origin/dev";

type Target = "main" | "rag";

function parseTarget(argv: string[]): Target {
  const arg = argv.find((a) => a.startsWith("--target="));
  const value = arg?.slice("--target=".length);
  if (value !== "main" && value !== "rag") {
    throw new Error(`--target must be 'main' or 'rag' (got '${value}')`);
  }
  return value;
}

function envVarFor(target: Target): string {
  return target === "main" ? "SUPABASE_DB_URL" : "SUPABASE_RAG_DB_URL";
}

// A migration filename is `<version>_<slug>.sql`. Ledger `name` is the slug
// (Supabase's `supabase db push` inserts everything after the version prefix
// and before `.sql` as `name`).
export function parseVersionAndName(filename: string): { version: string; name: string } | null {
  const m = filename.match(/^(\d+)_(.+)\.sql$/);
  return m ? { version: m[1]!, name: m[2]! } : null;
}

export interface LedgerCollision {
  version: string;
  branchFile: string;
  branchName: string;
  ledgerName: string;
}

// Pure core: given the branch's added migration filenames and the ledger's
// (version -> name) rows, return collisions.
export function findLedgerCollisions(
  addedFilenames: string[],
  ledger: Map<string, string>,
): LedgerCollision[] {
  const collisions: LedgerCollision[] = [];
  for (const branchFile of addedFilenames) {
    const parsed = parseVersionAndName(branchFile);
    if (!parsed) continue;
    const ledgerName = ledger.get(parsed.version);
    if (ledgerName !== undefined && ledgerName !== parsed.name) {
      collisions.push({
        version: parsed.version,
        branchFile,
        branchName: parsed.name,
        ledgerName,
      });
    }
  }
  return collisions;
}

function addedMigrationsVsBase(target: Target): { files: string[]; ok: boolean } {
  const prefix = `apps/${target}/supabase/migrations/`;
  try {
    const out = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=A", `${BASE_REF}...HEAD`],
      { encoding: "utf8", cwd: REPO_ROOT },
    );
    const files = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith(prefix) && l.endsWith(".sql"))
      .map((l) => path.basename(l));
    return { files, ok: true };
  } catch {
    return { files: [], ok: false };
  }
}

interface LedgerRow {
  version: string;
  name: string;
}

async function fetchLedger(dbUrl: string): Promise<Map<string, string>> {
  const sql = postgres(dbUrl, { max: 1, idle_timeout: 10, connect_timeout: 10 });
  try {
    const rows = await sql<LedgerRow[]>`
      SELECT version, coalesce(name, '') AS name
      FROM supabase_migrations.schema_migrations
    `;
    return new Map(rows.map((r) => [r.version, r.name]));
  } finally {
    await sql.end();
  }
}

async function main(): Promise<void> {
  const target = parseTarget(process.argv.slice(2));
  const envVar = envVarFor(target);
  const dbUrl = process.env[envVar];

  if (!dbUrl) {
    console.log(`migration-ledger guard [${target}]: SKIPPED — ${envVar} not set.`);
    return;
  }

  const { files: added, ok } = addedMigrationsVsBase(target);
  if (!ok) {
    console.warn(
      `migration-ledger guard [${target}]: could not compute 'git diff ${BASE_REF}...HEAD' — skipping.`,
    );
    return;
  }
  if (added.length === 0) {
    console.log(`migration-ledger guard [${target}]: ok — no new migrations to check.`);
    return;
  }

  let ledger: Map<string, string>;
  try {
    ledger = await fetchLedger(dbUrl);
  } catch (err) {
    console.warn(
      `migration-ledger guard [${target}]: could not query the ledger (${(err as Error).message}) — skipping. ` +
        "'supabase db push' will still fail loudly on a real conflict.",
    );
    return;
  }

  const collisions = findLedgerCollisions(added, ledger);
  if (collisions.length === 0) {
    console.log(`migration-ledger guard [${target}]: ok — no version collides with the test DB ledger.`);
    return;
  }

  console.error(
    `migration-ledger guard [${target}]: this branch's migration version(s) already exist in the ` +
      "shared test DB ledger under a DIFFERENT migration.\n",
  );
  for (const c of collisions) {
    console.error(
      `  version ${c.version}:\n` +
        `    this branch:        ${c.branchFile}\n` +
        `    already in ledger:  ${c.version}_${c.ledgerName || "(unnamed)"}.sql\n` +
        "    A sibling PR already merged and applied a DIFFERENT migration under this exact version " +
        "(the #1660 parallel-agent collision). Pushing now would corrupt the shared test DB ledger for " +
        "every other open PR.\n" +
        `    Fix: rename this branch's migration with a fresh version via ` +
        `scripts/new-migration.sh ${target} <slug>, then re-push.\n`,
    );
  }
  process.exit(1);
}

// Only run when invoked directly (`tsx scripts/check-migration-ledger.ts`);
// importing the module for unit tests must NOT trigger argv parsing or a DB call.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("check-migration-ledger: unexpected error:", redactSecrets(err));
    process.exit(1);
  });
}
