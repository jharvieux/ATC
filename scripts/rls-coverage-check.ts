// §30.8 RLS coverage check.
//
// Catches the failure modes the RLS snapshot diff alone can't:
//   - A tenant-scoped table (i.e., one with a `tenant_id` column) that
//     enabled RLS but defined zero policies — silent-deny trap; every read
//     returns nothing, which masks data-loss as "user has no records".
//   - A tenant-scoped table with RLS enabled but missing one or more of
//     SELECT/INSERT/UPDATE/DELETE policies — partial coverage means the
//     uncovered command is silently denied for everyone (operator runs
//     a single migration and discovers app traffic stops).
//   - Any policy whose USING or WITH CHECK clause is literally `true` —
//     equivalent to no RLS; flagged unless explicitly allowlisted with
//     a REASON comment in db/rls-exceptions.sql.
//   - Any SECURITY DEFINER function in `public` schema without
//     `SET search_path = ''` — §5.1.1 contract; without it a malicious
//     schema-search-path attacker can replace functions referenced by
//     the definer's body.
//
// Tables on the exception list (db/rls-exceptions.sql) are skipped. Each
// exception requires a `-- REASON: <text>` comment alongside.
//
// Connects via SUPABASE_DB_URL (operator-set; reuse the same secret CI
// uses for the snapshot diff job).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { redactSecrets } from "./lib/redact-secrets";

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error(
    "Error: SUPABASE_DB_URL must be set to a direct Postgres connection URL.\n" +
      "In CI this comes from the SUPABASE_TEST_DB_URL secret (same as rls-snapshot-diff).",
  );
  process.exit(1);
}

const EXCEPTIONS_PATH = resolve(__dirname, "..", "db", "rls-exceptions.sql");

interface TableRow {
  tablename: string;
  rowsecurity: boolean;
  has_tenant_id: boolean;
}

interface PolicyRow {
  tablename: string;
  policyname: string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
}

interface DefinerRow {
  function_name: string;
  signature: string;
  search_path_setting: string | null;
}

interface CoverageFlag {
  kind:
    | "rls_enabled_no_policies"
    | "missing_cmd_policy"
    | "using_true"
    | "with_check_true"
    | "definer_missing_search_path";
  table_or_function: string;
  detail: string;
}

function loadExceptions(): {
  tables: Set<string>;
  policies: Set<string>; // "tablename:policyname"
  definers: Set<string>; // function_name(args)
} {
  const tables = new Set<string>();
  const policies = new Set<string>();
  const definers = new Set<string>();
  try {
    const raw = readFileSync(EXCEPTIONS_PATH, "utf8");
    // Lines look like:
    //   skip_table: tablename  -- REASON: ...
    //   skip_policy: tablename:policyname  -- REASON: ...
    //   skip_definer: function_name(arg, arg)  -- REASON: ...
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("--")) continue;
      const reasonMatch = trimmed.match(/-- REASON:\s*\S/);
      if (!reasonMatch) {
        console.error(
          `Error in ${EXCEPTIONS_PATH}: every skip entry needs a "-- REASON: <text>" comment. Offending line: ${line}`,
        );
        process.exit(2);
      }
      const beforeReason = trimmed.split("--")[0]?.trim() ?? "";
      const [kind, ...rest] = beforeReason.split(":");
      const ident = rest.join(":").trim().replace(/;?$/, "");
      if (!kind || !ident) continue;
      if (kind === "skip_table") tables.add(ident);
      else if (kind === "skip_policy") policies.add(ident);
      else if (kind === "skip_definer") definers.add(ident);
      else {
        console.error(
          `Error in ${EXCEPTIONS_PATH}: unknown skip kind '${kind}'. Allowed: skip_table, skip_policy, skip_definer.`,
        );
        process.exit(2);
      }
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      // No exceptions file is fine — coverage check runs against the full schema.
      return { tables, policies, definers };
    }
    throw err;
  }
  return { tables, policies, definers };
}

const REQUIRED_CMDS = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

async function main(): Promise<void> {
  const sql = postgres(dbUrl as string, { max: 1, idle_timeout: 10 });
  const exceptions = loadExceptions();
  const flags: CoverageFlag[] = [];

  try {
    // Every `public.*` ordinary table + whether it has a tenant_id column +
    // RLS state. We rely on information_schema for column presence (portable)
    // and pg_class for the rowsecurity flag (catalog truth).
    const tables = await sql<TableRow[]>`
      SELECT
        c.relname AS tablename,
        c.relrowsecurity AS rowsecurity,
        EXISTS (
          SELECT 1
          FROM information_schema.columns ic
          WHERE ic.table_schema = 'public'
            AND ic.table_name = c.relname
            AND ic.column_name = 'tenant_id'
        ) AS has_tenant_id
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
          WHEN '*' THEN 'ALL'
          ELSE p.polcmd::text
        END AS cmd,
        pg_get_expr(p.polqual, p.polrelid) AS qual,
        pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
      ORDER BY c.relname, p.polname
    `;

    // SECURITY DEFINER functions in public + their search_path setting.
    // proconfig is a TEXT[] of GUC=VALUE; we look for a search_path=… entry.
    const definers = await sql<DefinerRow[]>`
      SELECT
        p.proname AS function_name,
        p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature,
        (
          SELECT split_part(c, '=', 2)
          FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c
          WHERE c LIKE 'search_path=%'
          LIMIT 1
        ) AS search_path_setting
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef = true
      ORDER BY signature
    `;

    // Group policies by table for quick lookup.
    const policiesByTable = new Map<string, PolicyRow[]>();
    for (const p of policies) {
      const list = policiesByTable.get(p.tablename) ?? [];
      list.push(p);
      policiesByTable.set(p.tablename, list);
    }

    for (const t of tables) {
      if (exceptions.tables.has(t.tablename)) continue;
      const tablePolicies = policiesByTable.get(t.tablename) ?? [];

      // (a) RLS enabled but zero policies → silent-deny trap.
      if (t.rowsecurity && tablePolicies.length === 0) {
        flags.push({
          kind: "rls_enabled_no_policies",
          table_or_function: t.tablename,
          detail:
            "RLS is ON but no policies are defined. Every command returns / writes nothing for non-superusers. Add policies or remove RLS.",
        });
      }

      // (b) tenant-scoped tables MUST have RLS + full CRUD policy coverage.
      if (t.has_tenant_id) {
        if (!t.rowsecurity) {
          flags.push({
            kind: "missing_cmd_policy",
            table_or_function: t.tablename,
            detail: "table has a tenant_id column but RLS is disabled.",
          });
        } else {
          const cmdsCovered = new Set<string>();
          for (const p of tablePolicies) {
            if (p.cmd === "ALL") {
              for (const c of REQUIRED_CMDS) cmdsCovered.add(c);
            } else {
              cmdsCovered.add(p.cmd);
            }
          }
          const missing = REQUIRED_CMDS.filter((c) => !cmdsCovered.has(c));
          if (missing.length > 0) {
            flags.push({
              kind: "missing_cmd_policy",
              table_or_function: t.tablename,
              detail: `tenant-scoped table is missing policy for: ${missing.join(", ")}.`,
            });
          }
        }
      }

      // (c) USING (true) / WITH CHECK (true) on a tenant-scoped table.
      for (const p of tablePolicies) {
        const policyKey = `${t.tablename}:${p.policyname}`;
        if (exceptions.policies.has(policyKey)) continue;
        if (p.qual?.trim() === "true") {
          flags.push({
            kind: "using_true",
            table_or_function: t.tablename,
            detail: `policy '${p.policyname}' has USING (true) — equivalent to no RLS. Add an explicit predicate or allowlist with a REASON.`,
          });
        }
        if (p.with_check?.trim() === "true") {
          flags.push({
            kind: "with_check_true",
            table_or_function: t.tablename,
            detail: `policy '${p.policyname}' has WITH CHECK (true). Add an explicit predicate or allowlist with a REASON.`,
          });
        }
      }
    }

    for (const d of definers) {
      if (exceptions.definers.has(d.signature)) continue;
      const sp = d.search_path_setting?.trim() ?? "";
      // §5.1.1: SECURITY DEFINER functions MUST set search_path to an empty
      // string ('' or "") so the resolver only walks pg_catalog + pg_temp.
      const isEmpty = sp === "''" || sp === '""' || sp === "";
      if (!isEmpty) {
        flags.push({
          kind: "definer_missing_search_path",
          table_or_function: d.signature,
          detail: `SECURITY DEFINER function missing SET search_path = '' (got: ${sp || "<unset>"}). Per §5.1.1.`,
        });
      }
    }

    if (flags.length === 0) {
      console.log(
        `RLS coverage check passed: ${tables.length} tables, ${policies.length} policies, ${definers.length} SECURITY DEFINER functions.`,
      );
      process.exit(0);
    }

    console.error(`\nRLS coverage check FAILED — ${flags.length} flag(s):\n`);
    const byKind = new Map<string, CoverageFlag[]>();
    for (const f of flags) {
      const list = byKind.get(f.kind) ?? [];
      list.push(f);
      byKind.set(f.kind, list);
    }
    for (const [kind, list] of byKind) {
      console.error(`  [${kind}] (${list.length})`);
      for (const f of list) {
        console.error(`    - ${f.table_or_function}: ${f.detail}`);
      }
      console.error("");
    }
    console.error(
      `Either fix the schema or add an entry to db/rls-exceptions.sql with a -- REASON comment.`,
    );
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("rls-coverage-check crashed:", redactSecrets(err));
  process.exit(2);
});
