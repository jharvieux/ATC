import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";

const dbUrl = process.env.SUPABASE_DB_URL;

if (!dbUrl) {
  console.error(
    "Error: SUPABASE_DB_URL must be set to a Postgres connection URL.\n" +
      "Locally: source .env.local; SUPABASE_DB_URL points at the atc-main pooler.\n" +
      "CI: provided by the SUPABASE_TEST_DB_URL secret.",
  );
  process.exit(1);
}

const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? path.join("apps", "main", "supabase", "migrations");

async function main(): Promise<void> {
  const sql = postgres(dbUrl!, { max: 1, idle_timeout: 10, onnotice: () => {} });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    if (!fs.existsSync(MIGRATIONS_DIR)) {
      console.error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
      process.exit(1);
    }

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    if (files.length === 0) {
      console.log("No migrations to apply.");
      return;
    }

    const applied = await sql<{ version: string }[]>`
      SELECT version FROM public.schema_migrations
    `;
    const appliedVersions = new Set(applied.map((r) => r.version));

    let appliedCount = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");

      if (appliedVersions.has(version)) {
        console.log(`SKIP  ${version} (already applied)`);
        continue;
      }

      const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`APPLY ${version}`);

      await sql.begin(async (tx) => {
        await tx.unsafe(content);
        await tx`INSERT INTO public.schema_migrations (version) VALUES (${version})`;
      });

      appliedCount += 1;
    }

    console.log(
      appliedCount === 0
        ? "All migrations up to date."
        : `Applied ${appliedCount} migration(s).`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
