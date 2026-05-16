import postgres from "postgres";

const dbUrl = process.env.SUPABASE_DB_URL;

if (!dbUrl) {
  console.error(
    "Error: SUPABASE_DB_URL must be set to a direct Postgres connection URL.\n" +
      "Find it in Supabase dashboard → Project Settings → Database → Connection string (URI).",
  );
  process.exit(1);
}

const sql = postgres(dbUrl, { max: 1, idle_timeout: 10 });

interface TableRow {
  tablename: string;
  rowsecurity: boolean;
}

interface PolicyRow {
  tablename: string;
  policyname: string;
  cmd: string;
  roles: string[];
  qual: string | null;
  with_check: string | null;
}

export async function generateSnapshot(): Promise<string> {
  const tables = await sql<TableRow[]>`
    SELECT c.relname AS tablename, c.relrowsecurity AS rowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `;

  const policies = await sql<PolicyRow[]>`
    SELECT
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
    WHERE n.nspname = 'public'
    ORDER BY c.relname, p.polname
  `;

  const lines: string[] = [
    "-- AUTO-GENERATED RLS SNAPSHOT - DO NOT EDIT MANUALLY",
    "-- Regenerate with: npx tsx scripts/rls-snapshot.ts > db/rls-snapshot.sql",
    "-- Generated against schema: public",
    "",
  ];

  const rlsEnabled = tables.filter((t) => t.rowsecurity);
  const rlsDisabled = tables.filter((t) => !t.rowsecurity);

  lines.push("-- Tables with RLS enabled:");
  if (rlsEnabled.length === 0) {
    lines.push("-- (none)");
  } else {
    for (const t of rlsEnabled) {
      lines.push(`-- public.${t.tablename} (rls_enabled)`);
    }
  }

  if (rlsDisabled.length > 0) {
    lines.push("--");
    lines.push("-- Tables with RLS disabled:");
    for (const t of rlsDisabled) {
      lines.push(`-- public.${t.tablename} (rls_disabled)`);
    }
  }

  lines.push("");
  lines.push("-- Policies:");

  const byTable = new Map<string, PolicyRow[]>();
  for (const p of policies) {
    if (!byTable.has(p.tablename)) byTable.set(p.tablename, []);
    byTable.get(p.tablename)!.push(p);
  }

  if (byTable.size === 0) {
    lines.push("-- (none)");
  } else {
    for (const tablename of Array.from(byTable.keys()).sort()) {
      lines.push(`-- TABLE: public.${tablename}`);
      for (const p of byTable.get(tablename)!) {
        const roles = p.roles.length === 0 ? "PUBLIC" : p.roles.join(", ");
        let stmt = `CREATE POLICY "${p.policyname}" ON public.${tablename}\n  FOR ${p.cmd} TO ${roles}`;
        if (p.qual) stmt += `\n  USING (${p.qual})`;
        if (p.with_check) stmt += `\n  WITH CHECK (${p.with_check})`;
        stmt += ";";
        lines.push(stmt);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

generateSnapshot()
  .then((snapshot) => {
    process.stdout.write(snapshot + "\n");
    sql.end();
  })
  .catch((err) => {
    console.error("Error generating RLS snapshot:", (err as Error).message);
    sql.end();
    process.exit(1);
  });
