// CI-only reset of the shared MAIN test DB to a clean slate, so the
// `supabase db push --include-all` step that follows can rebuild every
// migration from scratch — independent of whatever an abandoned branch left
// in the shared supabase_migrations ledger.
//
// Why this exists (#1660 / docs/runbooks/migrations.md §4): the test DB's
// ledger is shared across CI runs. A migration that was applied by a branch
// that never merged orphans a ledger row, and every other branch's
// `supabase db push` then fails with "repair the migration history table".
// Resetting the schema + ledger before the push makes each run's apply
// self-contained, which is the precondition for GitHub's merge queue to be
// safe here (a speculative merge must apply cleanly regardless of queue order)
// AND a strict improvement for today's non-queue flow (no more orphan-row
// wedging). See #1896 groundwork.
//
// Scope: the MAIN test DB only (SUPABASE_DB_URL). Drops + recreates `public`
// — the only schema the app's migrations own, matching scripts/db-reset.ts's
// proven local reset — and empties the migration ledger. Supabase-managed
// schemas (auth, storage, graphql, realtime, vault) are owned by
// supabase_admin: the postgres role can't drop them and the migrations don't
// need them dropped. The RAG test DB is not reset here (deploy.yml never
// pushes it; see the PR body's follow-up note).
//
// Serialization: this MUST run under the `shared-test-db` GitHub Actions
// concurrency group so no other job reads or writes the same DB while the
// schema is mid-rebuild (a reader would otherwise observe an empty/partial
// schema). deploy.yml + nightly-full-test.yml set that group on every job
// that touches this DB.
//
// Safety: refuses to run unless CONFIRM_TEST_DB_RESET=true is set by the
// caller, so merely having SUPABASE_DB_URL in the environment can never wipe a
// DB. A secret-less run (Dependabot) has no URL and skips (exit 0), the same
// posture as deploy.yml's apply step.

import postgres from "postgres";
import { redactSecrets } from "./lib/redact-secrets";

const dbUrl = process.env.SUPABASE_DB_URL;

if (process.env.CONFIRM_TEST_DB_RESET !== "true") {
  console.error(
    "ci-reset-test-db: refusing to run — set CONFIRM_TEST_DB_RESET=true to confirm this destructive reset. " +
      "This guard keeps a stray SUPABASE_DB_URL from ever wiping a database.",
  );
  process.exit(1);
}

if (!dbUrl) {
  console.log(
    "ci-reset-test-db: SUPABASE_DB_URL not set — skipping reset (Dependabot / secret-less run).",
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
      "ci-reset-test-db: main test DB reset — public schema recreated, migration ledger emptied. " +
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
