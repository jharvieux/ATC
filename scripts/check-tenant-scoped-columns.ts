// #1054 — TENANT_SCOPED_TABLES ↔ schema consistency guard.
//
// Prevents the #1045 class of bug: a table with NO `tenant_id` column listed
// in TENANT_SCOPED_TABLES. The `tenantClient` proxy injects
// `.eq("tenant_id", …)` against every scoped table, and Postgres HARD-ERRORS
// ("column <t>.tenant_id does not exist") rather than returning zero rows —
// that 500'd signup at the legal-accept step when `legal_documents` was
// mis-listed. Such a table belongs in PLATFORM_READABLE_TABLES instead.
//
// Two failure directions, both checked here:
//
//   (1) TENANT_SCOPED_TABLES entry WITHOUT a tenant_id column → FAIL.
//       This is the #1045/#1054 bug. There is no valid exception: auto-scoping
//       is impossible without the column.
//
//   (2) PLATFORM_READABLE_TABLES entry WITH a tenant_id column → FAIL unless
//       allowlisted. This is the scarier inverse: a tenant-scoped table routed
//       through the unscoped passthrough is a silent cross-tenant leak (no
//       error, just every tenant's rows). There are no current exceptions.
//
// Tables named in the sets but ABSENT from the schema (not-yet-created, or
// living in the separate RAG database) are reported as warnings, not failures —
// the sets intentionally list tables ahead of their migrations.
//
// Materialized views are included (relkind 'm') so tenant-scoped rollups like
// `attribution_rollup` are verified, not skipped.
//
// Connects via SUPABASE_DB_URL (same secret the RLS coverage/snapshot jobs use;
// in CI this is SUPABASE_TEST_DB_URL). DB-backed, so it runs in the e2e
// workflow alongside `rls:coverage`, not in the offline `pnpm verify` chain.

import postgres from "postgres";
import {
  TENANT_SCOPED_TABLES,
  PLATFORM_READABLE_TABLES,
} from "../apps/main/src/lib/db/tenant-scoped-tables";
import { redactSecrets } from "./lib/redact-secrets";

// Any future exception must document why a tenant_id-bearing table may bypass
// automatic scoping. No current table has that exception.
const PLATFORM_READABLE_TENANT_ID_OK: ReadonlyMap<string, string> = new Map();

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error(
    "Error: SUPABASE_DB_URL must be set to a direct Postgres connection URL.\n" +
      "In CI this comes from the SUPABASE_TEST_DB_URL secret (same as rls-coverage).",
  );
  process.exit(1);
}

interface RelRow {
  relname: string;
  has_tenant_id: boolean;
}

async function main(): Promise<void> {
  const sql = postgres(dbUrl as string, { max: 1, idle_timeout: 10 });

  const failures: string[] = [];
  const warnings: string[] = [];

  try {
    // Ordinary tables (relkind 'r') + materialized views (relkind 'm') in
    // public, each with whether a live (non-dropped) tenant_id column exists.
    const rels = await sql<RelRow[]>`
      SELECT
        c.relname AS relname,
        EXISTS (
          SELECT 1
          FROM pg_attribute a
          WHERE a.attrelid = c.oid
            AND a.attname = 'tenant_id'
            AND a.attnum > 0
            AND NOT a.attisdropped
        ) AS has_tenant_id
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'm')
    `;

    const hasTenantId = new Map<string, boolean>();
    for (const r of rels) hasTenantId.set(r.relname, r.has_tenant_id);

    // Direction (1): every scoped table must have a tenant_id column.
    for (const table of TENANT_SCOPED_TABLES) {
      const present = hasTenantId.get(table);
      if (present === undefined) {
        warnings.push(
          `TENANT_SCOPED_TABLES lists '${table}', which is not a table/matview in this database (not-yet-created or in the RAG DB?). Cannot verify its tenant_id column.`,
        );
      } else if (!present) {
        failures.push(
          `'${table}' is in TENANT_SCOPED_TABLES but has NO tenant_id column. ` +
            `tenantClient would inject .eq("tenant_id", …) and Postgres would hard-error. ` +
            `Move it to PLATFORM_READABLE_TABLES (callers self-scope).`,
        );
      }
    }

    // Direction (2): a passthrough table with a tenant_id column is a silent
    // cross-tenant leak unless deliberately allowlisted.
    for (const table of PLATFORM_READABLE_TABLES) {
      const present = hasTenantId.get(table);
      if (present === undefined) {
        warnings.push(
          `PLATFORM_READABLE_TABLES lists '${table}', which is not a table/matview in this database. Cannot verify its tenant_id column.`,
        );
      } else if (present && !PLATFORM_READABLE_TENANT_ID_OK.has(table)) {
        failures.push(
          `'${table}' is in PLATFORM_READABLE_TABLES but HAS a tenant_id column. ` +
            `Passthrough does not scope it — every tenant's rows are returned. ` +
            `Move it to TENANT_SCOPED_TABLES, or allowlist it in ` +
            `PLATFORM_READABLE_TENANT_ID_OK with a reason if cross-tenant access is intended.`,
        );
      }
    }

    for (const w of warnings) console.warn(`  [warn] ${w}`);

    if (failures.length === 0) {
      console.log(
        `tenant-scoped-columns check passed: ${TENANT_SCOPED_TABLES.size} scoped + ` +
          `${PLATFORM_READABLE_TABLES.size} platform-readable tables verified` +
          (warnings.length ? ` (${warnings.length} warning(s))` : "") +
          ".",
      );
      process.exit(0);
    }

    console.error(
      `\ntenant-scoped-columns check FAILED — ${failures.length} problem(s):\n`,
    );
    for (const f of failures) console.error(`  - ${f}`);
    console.error(
      `\nEdit apps/main/src/lib/db/tenant-scoped-tables.ts to fix the classification.`,
    );
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("check-tenant-scoped-columns crashed:", redactSecrets(err));
  process.exit(2);
});
