// Generate a table-GRANTS snapshot for either the main or rag Supabase database.
//
// Usage:
//   tsx scripts/grants-snapshot.ts --target=main > db/grants-snapshot-main.sql
//   tsx scripts/grants-snapshot.ts --target=rag  > db/grants-snapshot-rag.sql
//
// Env vars:
//   SUPABASE_DB_URL      — required for --target=main
//   SUPABASE_RAG_DB_URL  — required for --target=rag
//
// Why this exists (issue #546): the RLS snapshot captures rowsecurity + policies
// but NOT table grants, so a table shipped without its `grant ... to service_role`
// block (the #544 prod outage) produced no diff. This snapshot captures the DML
// grants for the three PostgREST roles on every public base table, so a missing
// or widened grant surfaces as drift.
//
// Scope: DML privileges (SELECT, INSERT, UPDATE, DELETE) for anon, authenticated,
// and service_role. Structural privileges (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN)
// are excluded — they are not security-relevant and are uniformly auto-granted by
// Postgres defaults, so including them would be pure noise.

import postgres from "postgres";

type Target = "main" | "rag";

// Roles and privileges are emitted in this fixed order so the snapshot is
// deterministic regardless of catalog row order.
const ROLE_ORDER = ["anon", "authenticated", "service_role"] as const;
const PRIVILEGE_ORDER = ["DELETE", "INSERT", "SELECT", "UPDATE"] as const;

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
  tablename: string;
}

interface GrantRow {
  tablename: string;
  role: string;
  privilege: string;
}

export async function generateSnapshot(target: Target = "main"): Promise<string> {
  const sql = postgres(resolveDbUrl(target), { max: 1, idle_timeout: 10 });
  try {
    const tables = await sql<TableRow[]>`
      SELECT c.relname AS tablename
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname
    `;

    const grants = await sql<GrantRow[]>`
      SELECT c.relname AS tablename,
             r.rolname AS role,
             a.privilege_type AS privilege
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
      JOIN pg_roles r ON r.oid = a.grantee
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND r.rolname IN ('anon', 'authenticated', 'service_role')
        AND a.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
    `;

    // table -> role -> set of privileges
    const byTable = new Map<string, Map<string, Set<string>>>();
    for (const g of grants) {
      let roles = byTable.get(g.tablename);
      if (!roles) {
        roles = new Map<string, Set<string>>();
        byTable.set(g.tablename, roles);
      }
      let privs = roles.get(g.role);
      if (!privs) {
        privs = new Set<string>();
        roles.set(g.role, privs);
      }
      privs.add(g.privilege);
    }

    const lines: string[] = [
      "-- AUTO-GENERATED GRANTS SNAPSHOT - DO NOT EDIT MANUALLY",
      `-- Target: ${target}`,
      `-- Regenerate with: npx tsx scripts/grants-snapshot.ts --target=${target} > db/grants-snapshot-${target}.sql`,
      "-- Generated against schema: public",
      "-- Captures DML grants (SELECT, INSERT, UPDATE, DELETE) for roles anon, authenticated, service_role.",
      "",
    ];

    for (const t of tables) {
      lines.push(`-- TABLE: public.${t.tablename}`);
      const roles = byTable.get(t.tablename);
      let emitted = false;
      for (const role of ROLE_ORDER) {
        const privs = roles?.get(role);
        if (!privs || privs.size === 0) continue;
        const ordered = PRIVILEGE_ORDER.filter((p) => privs.has(p));
        lines.push(`GRANT ${ordered.join(", ")} ON public.${t.tablename} TO ${role};`);
        emitted = true;
      }
      if (!emitted) {
        lines.push("-- (no DML grants to anon/authenticated/service_role)");
      }
      lines.push("");
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
      console.error(`Error generating grants snapshot (target=${target}):`, (err as Error).message);
      process.exit(1);
    });
}
