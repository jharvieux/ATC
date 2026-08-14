// Generate an RLS snapshot for either the main or rag Supabase database.
//
// Usage:
//   tsx scripts/rls-snapshot.ts --target=main > db/rls-snapshot-main.sql
//   tsx scripts/rls-snapshot.ts --target=rag  > db/rls-snapshot-rag.sql
//
// Env vars:
//   SUPABASE_DB_URL      — required for --target=main
//   SUPABASE_RAG_DB_URL  — required for --target=rag
//
// The snapshot text is identical in shape across targets so the diff
// script can compare them without target-specific logic.

import postgres from "postgres";

type Target = "main" | "rag";

function parseTarget(argv: string[]): Target {
  const arg = argv.find((a) => a.startsWith("--target="));
  if (!arg) return "main";
  const value = arg.slice("--target=".length);
  if (value !== "main" && value !== "rag") {
    throw new Error(`--target must be 'main' or 'rag' (got '${value}')`);
  }
  return value;
}

function resolveDbUrl(target: Target): string {
  const envVar = target === "main" ? "SUPABASE_DB_URL" : "SUPABASE_RAG_DB_URL";
  const url = process.env[envVar];
  if (!url) {
    throw new Error(
      `${envVar} must be set to a direct Postgres connection URL.\n` +
        "Find it in the Supabase dashboard → Project Settings → Database → Connection string (URI).",
    );
  }
  return url;
}

interface TableRow {
  schemaname: string;
  tablename: string;
  rowsecurity: boolean;
}

interface PolicyRow {
  schemaname: string;
  tablename: string;
  policyname: string;
  cmd: string;
  roles: string[];
  qual: string | null;
  with_check: string | null;
}

export async function generateSnapshot(target: Target = "main"): Promise<string> {
  const sql = postgres(resolveDbUrl(target), { max: 1, idle_timeout: 10 });
  try {
    const tables = await sql<TableRow[]>`
      SELECT n.nspname AS schemaname, c.relname AS tablename, c.relrowsecurity AS rowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE (n.nspname = 'public' OR (n.nspname = 'storage' AND c.relname = 'objects'))
        AND c.relkind = 'r'
      ORDER BY n.nspname, c.relname
    `;

    const policies = await sql<PolicyRow[]>`
      SELECT
        n.nspname AS schemaname,
        c.relname AS tablename,
        p.polname AS policyname,
        CASE p.polcmd
          WHEN 'r' THEN 'SELECT'
          WHEN 'a' THEN 'INSERT'
          WHEN 'w' THEN 'UPDATE'
          WHEN 'd' THEN 'DELETE'
          ELSE 'ALL'
        END AS cmd,
        ARRAY(
          SELECT rolname FROM pg_roles WHERE oid = ANY(p.polroles)
        ) AS roles,
        pg_get_expr(p.polqual, p.polrelid, true) AS qual,
        pg_get_expr(p.polwithcheck, p.polrelid, true) AS with_check
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' OR (n.nspname = 'storage' AND c.relname = 'objects')
      ORDER BY n.nspname, c.relname, p.polname
    `;

    const lines: string[] = [
      "-- AUTO-GENERATED RLS SNAPSHOT - DO NOT EDIT MANUALLY",
      `-- Target: ${target}`,
      `-- Regenerate with: npx tsx scripts/rls-snapshot.ts --target=${target} > db/rls-snapshot-${target}.sql`,
      "-- Generated against schemas: public, storage.objects",
      "",
    ];

    const rlsEnabled = tables.filter((t) => t.rowsecurity);
    const rlsDisabled = tables.filter((t) => !t.rowsecurity);

    lines.push("-- Tables with RLS enabled:");
    if (rlsEnabled.length === 0) {
      lines.push("-- (none)");
    } else {
      for (const t of rlsEnabled) {
        lines.push(`-- ${t.schemaname}.${t.tablename} (rls_enabled)`);
      }
    }

    if (rlsDisabled.length > 0) {
      lines.push("--");
      lines.push("-- Tables with RLS disabled:");
      for (const t of rlsDisabled) {
        lines.push(`-- ${t.schemaname}.${t.tablename} (rls_disabled)`);
      }
    }

    lines.push("");
    lines.push("-- Policies:");

    const byTable = new Map<string, PolicyRow[]>();
    for (const p of policies) {
      const qualifiedTable = `${p.schemaname}.${p.tablename}`;
      if (!byTable.has(qualifiedTable)) byTable.set(qualifiedTable, []);
      byTable.get(qualifiedTable)!.push(p);
    }

    if (byTable.size === 0) {
      lines.push("-- (none)");
    } else {
      for (const qualifiedTable of Array.from(byTable.keys()).sort()) {
        lines.push(`-- TABLE: ${qualifiedTable}`);
        for (const p of byTable.get(qualifiedTable)!) {
          const roles = p.roles.length === 0 ? "PUBLIC" : p.roles.join(", ");
          let stmt = `CREATE POLICY "${p.policyname}" ON ${qualifiedTable}\n  FOR ${p.cmd} TO ${roles}`;
          if (p.qual) stmt += `\n  USING (${p.qual})`;
          if (p.with_check) stmt += `\n  WITH CHECK (${p.with_check})`;
          stmt += ";";
          lines.push(stmt);
        }
        lines.push("");
      }
    }

    return lines.join("\n");
  } finally {
    await sql.end();
  }
}

// Module-as-script: only run when invoked directly (allow generateSnapshot to be imported by the diff script).
if (import.meta.url === `file://${process.argv[1]}`) {
  let target: Target;
  try {
    target = parseTarget(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  generateSnapshot(target)
    .then((snapshot) => {
      process.stdout.write(snapshot + "\n");
    })
    .catch((err) => {
      console.error(`Error generating RLS snapshot (target=${target}):`, (err as Error).message);
      process.exit(1);
    });
}
