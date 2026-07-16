// CI-only reset of a shared test DB (main or RAG) to a clean slate, so the
// `supabase db push --include-all` step that follows can rebuild every
// migration from scratch — independent of whatever an abandoned branch or
// failed push left in the shared supabase_migrations ledger.
//
// Why this exists (#1660 / docs/runbooks/migrations.md §4): the test DB's
// ledger is shared across CI runs. A migration that was applied by a branch
// that never merged (or a push that failed partway through) orphans a
// ledger row, and every other branch's `supabase db push` then fails with
// "repair the migration history table" (main) or "relation ... already
// exists" (RAG — the exact wedge #1914 confirmed live on #1919/#1920: 0001
// re-applies, 0002 fails because its table survived a prior failed push
// while its ledger row didn't). Resetting the schema + ledger before the
// push makes each run's apply self-contained, which is the precondition for
// GitHub's merge queue to be safe here (a speculative merge must apply
// cleanly regardless of queue order) AND a strict improvement for today's
// non-queue flow (no more orphan-row wedging). See #1896 groundwork, #1914.
//
// Usage: tsx scripts/ci-reset-test-db.ts [--target=main|rag]
// --target is a LOG LABEL ONLY — it does NOT select a database. Both values
// take byte-identical code paths; RESET_TARGET_DB_URL is the sole selector of
// what gets dropped, so `--target=rag` against a main URL resets MAIN. It
// exists to keep the CLI shape consistent with rls-snapshot-diff.ts and to
// make the logs say which DB the caller believed it was resetting. Defaults to
// "main" for the original call site's backward compatibility. Drops + recreates `public`
// — the only schema either app's migrations own, matching scripts/db-reset.ts's
// proven local reset — and empties the migration ledger. Supabase-managed
// schemas (auth, storage, graphql, realtime, vault) are owned by
// supabase_admin: the postgres role can't drop them and the migrations don't
// need them dropped.
//
// Target var — the name IS the safety contract (#1896 audit): this script reads
// RESET_TARGET_DB_URL, a DISTINCTLY-NAMED var that must only ever be bound to
// a throwaway test DB (main or RAG). It deliberately does NOT read the generic
// SUPABASE_DB_URL / SUPABASE_RAG_DB_URL, because SUPABASE_DB_URL is bound to the
// PRODUCTION database in prod-drift-check.yml — reading it here would let a
// future workflow author who copies a reset step next to a prod binding
// silently wipe prod. RESET_TARGET_DB_URL is bound to SUPABASE_TEST_DB_URL /
// SUPABASE_RAG_TEST_DB_URL at the step level by each call site and is never
// bound to a prod secret anywhere in the repo. The script hard-stops (below)
// if it is unset, so it can never fall back to some other ambient DB URL.
//
// Serialization: this MUST run under the `shared-test-db` GitHub Actions
// concurrency group so no other job reads or writes the same DB while the
// schema is mid-rebuild (a reader would otherwise observe an empty/partial
// schema). deploy.yml + nightly-full-test.yml set that group on every job
// that touches either test DB.
//
// Safety: refuses to run unless CONFIRM_TEST_DB_RESET=true is set by the
// caller, so merely having RESET_TARGET_DB_URL in the environment can never wipe
// a DB. A secret-less run (Dependabot) has no URL and skips (exit 0), the same
// posture as the apply step that follows it. That skip is for callers that
// legitimately run without secrets — a caller which REQUIRES the reset to have
// happened must check the URL itself before invoking (nightly-full-test.yml's
// RAG reset step does exactly that: on schedule/dispatch an unset secret means
// misnamed/rotated, and silently skipping would let the push re-wedge on 42P07
// with only a log line to show for it).

import postgres from "postgres";
import { redactSecrets } from "./lib/redact-secrets";

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

const target = parseTarget(process.argv.slice(2));
const dbUrl = process.env.RESET_TARGET_DB_URL;

if (process.env.CONFIRM_TEST_DB_RESET !== "true") {
  console.error(
    "ci-reset-test-db: refusing to run — set CONFIRM_TEST_DB_RESET=true to confirm this destructive reset. " +
      "This guard keeps a stray RESET_TARGET_DB_URL from ever wiping a database.",
  );
  process.exit(1);
}

if (!dbUrl) {
  console.log(
    `ci-reset-test-db: RESET_TARGET_DB_URL not set — skipping ${target} reset (Dependabot / secret-less run).`,
  );
  process.exit(0);
}

async function main(): Promise<void> {
  const sql = postgres(dbUrl!, {
    max: 1,
    idle_timeout: 10,
    connect_timeout: 15,
    onnotice: () => {},
  });

  try {
    // Evict lingering client connections first so DROP SCHEMA isn't blocked by
    // a lock held by a previous run's `supabase db push` pooler session. Scope
    // to NON-superuser client backends only — the Supabase postgres role can't
    // terminate superuser/system backends. Same technique as deploy.yml's
    // db-copy job.
    await sql.unsafe(`
      SELECT pg_terminate_backend(sa.pid)
      FROM pg_stat_activity sa
      JOIN pg_roles r ON r.rolname = sa.usename
      WHERE sa.datname = current_database()
        AND sa.pid <> pg_backend_pid()
        AND sa.backend_type = 'client backend'
        AND NOT r.rolsuper;
    `);

    // Drop + recreate public (restoring the default schema-level grants), then
    // empty the migration ledger so `db push --include-all` reapplies every
    // migration and records it fresh. TRUNCATE (guarded by existence) keeps the
    // ledger table's exact CLI-created shape rather than guessing its columns;
    // on a brand-new DB the table is absent and the CLI creates it on push.
    await sql.unsafe(`
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
      GRANT USAGE  ON SCHEMA public TO public;
      GRANT CREATE ON SCHEMA public TO public;
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'supabase_migrations'
            AND table_name = 'schema_migrations'
        ) THEN
          EXECUTE 'TRUNCATE supabase_migrations.schema_migrations';
        END IF;
      END $$;
    `);

    console.log(
      `ci-reset-test-db: ${target} test DB reset — public schema recreated, migration ledger emptied. ` +
        "'supabase db push --include-all' will now rebuild from scratch.",
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("ci-reset-test-db: reset failed:", redactSecrets(err));
  process.exit(1);
});
