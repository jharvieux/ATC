import postgres from "postgres";
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "./lib/redact-secrets";

const dbUrl = process.env.SUPABASE_DB_URL;
const allowed = process.env.ALLOW_DB_RESET === "true";

if (!allowed) {
  console.error(
    "Refusing to run: db:reset is destructive (drops the public schema).\n" +
      "To proceed, set ALLOW_DB_RESET=true in your shell:\n" +
      "  ALLOW_DB_RESET=true pnpm db:reset\n" +
      "This guard prevents accidental data loss against shared environments.",
  );
  process.exit(1);
}

if (!dbUrl) {
  console.error("Error: SUPABASE_DB_URL must be set.");
  process.exit(1);
}

async function main(): Promise<void> {
  const sql = postgres(dbUrl!, { max: 1, idle_timeout: 10, onnotice: () => {} });

  try {
    console.log("Dropping public schema...");

    await sql.unsafe(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'tenants'
        ) THEN
          SET LOCAL app.allow_tenant_hard_delete = 'true';
          PERFORM 1;
        END IF;
      END $$;

      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
      GRANT USAGE  ON SCHEMA public TO public;
      GRANT CREATE ON SCHEMA public TO public;
    `);

    console.log("Public schema dropped + recreated.");
  } finally {
    await sql.end();
  }

  const migrationsDir = join(process.cwd(), "apps/main/supabase/migrations");
  const migrations = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  console.log(`Reapplying ${migrations.length} migrations...`);
  for (const file of migrations) {
    // Pass dbUrl via env, not argv — argv is visible to other users via `ps`.
    execSync(`psql "$DB_RESET_PSQL_URL" -f "${join(migrationsDir, file)}"`, {
      stdio: "inherit",
      env: { ...process.env, DB_RESET_PSQL_URL: dbUrl! },
    });
  }
}

main().catch((err) => {
  console.error("Reset failed:", redactSecrets(err));
  process.exit(1);
});
