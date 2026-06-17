// Migration ledger ↔ live DB drift gate (orchestrator).
//
// Fails when the committed migration ledger (apps/*/supabase/migrations/*.sql)
// diverges from what the live DB reports in supabase_migrations.schema_migrations:
//
//   UNAPPLIED  — file exists in ledger, version absent from DB.
//                Root cause: db push failed silently, or was disabled (#534).
//
//   ORPHANED   — version present in DB, no matching file in ledger.
//                Root cause: migration applied directly in dashboard without a file.
//
// Usage:
//   tsx scripts/check-schema-drift.ts --target=main  # SUPABASE_DB_URL
//   tsx scripts/check-schema-drift.ts --target=rag   # SUPABASE_RAG_DB_URL
//   tsx scripts/check-schema-drift.ts                # both, skips any with missing env
//
// In deploy.yml, pass --db-url to override the env var:
//   tsx scripts/check-schema-drift.ts --target=main --db-url "$DB_URL"
//
// Exit 0 if no drift. Exit 1 if any drift detected.

import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

type Target = "main" | "rag";
const ALL_TARGETS: readonly Target[] = ["main", "rag"];

const APPS_DIR = "apps";

function parseArgs(argv: string[]): { target: Target | "all"; dbUrl: string | null } {
  const targetArg = argv.find((a) => a.startsWith("--target="));
  const dbUrlArg = argv.find((a) => a.startsWith("--db-url="));
  // --db-url may be passed as a separate next arg if the shell splits it
  const dbUrlNextIdx = argv.findIndex((a) => a === "--db-url");
  const dbUrl =
    dbUrlArg?.slice("--db-url=".length) ??
    (dbUrlNextIdx >= 0 ? argv[dbUrlNextIdx + 1] : null) ??
    null;

  if (!targetArg) return { target: "all", dbUrl };
  const value = targetArg.slice("--target=".length);
  if (value !== "main" && value !== "rag") {
    throw new Error(`--target must be 'main' or 'rag' (got '${value}')`);
  }
  return { target: value, dbUrl };
}

function envVarFor(target: Target): string {
  return target === "main" ? "SUPABASE_DB_URL" : "SUPABASE_RAG_DB_URL";
}

function appDirFor(target: Target): string {
  return target === "main" ? "main" : "rag";
}

function ledgerVersions(target: Target): string[] {
  const dir = path.join(APPS_DIR, appDirFor(target), "supabase", "migrations");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => f.replace(/\.sql$/, ""));
}

interface SchemaRow {
  version: string;
}

async function appliedVersions(dbUrl: string): Promise<string[]> {
  const sql = postgres(dbUrl, { max: 1, idle_timeout: 10, connect_timeout: 10 });
  try {
    const rows = await sql<SchemaRow[]>`
      SELECT version
      FROM supabase_migrations.schema_migrations
      ORDER BY version
    `;
    return rows.map((r) => r.version);
  } finally {
    await sql.end();
  }
}

async function checkTarget(
  target: Target,
  dbUrl: string | null,
): Promise<{ status: "ok" | "drift" | "skipped"; message: string }> {
  const resolvedUrl = dbUrl ?? process.env[envVarFor(target)] ?? null;
  if (!resolvedUrl) {
    return {
      status: "skipped",
      message: `[${target}] SKIPPED — ${envVarFor(target)} not set and --db-url not provided`,
    };
  }

  const ledger = ledgerVersions(target);
  if (ledger.length === 0) {
    return {
      status: "skipped",
      message: `[${target}] SKIPPED — no migration files found under ${APPS_DIR}/${appDirFor(target)}/supabase/migrations/`,
    };
  }

  let applied: string[];
  try {
    applied = await appliedVersions(resolvedUrl);
  } catch (err) {
    return {
      status: "drift",
      message: `[${target}] ERROR connecting to DB: ${(err as Error).message}`,
    };
  }

  const ledgerSet = new Set(ledger);
  const appliedSet = new Set(applied);

  const unapplied = ledger.filter((v) => !appliedSet.has(v));
  const orphaned = applied.filter((v) => !ledgerSet.has(v));

  if (unapplied.length === 0 && orphaned.length === 0) {
    return {
      status: "ok",
      message: `[${target}] no drift — ${ledger.length} migration(s) in ledger, all applied`,
    };
  }

  const lines: string[] = [`[${target}] MIGRATION DRIFT DETECTED`];
  if (unapplied.length > 0) {
    lines.push(
      "",
      `  UNAPPLIED (${unapplied.length}) — in ledger, NOT in DB:`,
      ...unapplied.map((v) => `    - ${v}`),
      "  Fix: run 'npx supabase db push' or check why the last push failed.",
    );
  }
  if (orphaned.length > 0) {
    lines.push(
      "",
      `  ORPHANED (${orphaned.length}) — in DB, NOT in ledger:`,
      ...orphaned.map((v) => `    - ${v}`),
      "  Fix: add a matching migration file to apps/" + appDirFor(target) + "/supabase/migrations/.",
    );
  }
  return { status: "drift", message: lines.join("\n") };
}

async function main(): Promise<void> {
  const { target, dbUrl } = parseArgs(process.argv.slice(2));
  const targets: Target[] = target === "all" ? [...ALL_TARGETS] : [target];

  const results = await Promise.all(targets.map((t) => checkTarget(t, dbUrl)));

  let anyDrift = false;
  for (const r of results) {
    if (r.status === "drift") {
      console.error(r.message);
      anyDrift = true;
    } else {
      console.log(r.message);
    }
  }

  if (anyDrift) {
    console.error(
      "\nMigration ledger ↔ live DB drift detected. " +
        "Ensure all migrations in the ledger have been applied to the target DB.",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("check-schema-drift: unexpected error:", (err as Error).message);
  process.exit(1);
});
