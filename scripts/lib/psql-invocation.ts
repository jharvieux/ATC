// #1849 — db-reset.ts previously interpolated the raw connection string into
// a shell command string (`psql "$DB_RESET_PSQL_URL" ...`); /bin/sh expands
// the var while building psql's own argv, so the credential still showed up
// in `ps` output for psql's process, not just node's. Parsing the URL here
// and passing host/port/user/db as discrete execFileSync argv elements —
// with the password only ever set via the PGPASSWORD env var, which libpq
// reads directly — keeps the secret out of every process's command line.

export interface PsqlInvocation {
  args: string[];
  env: Record<string, string>;
}

// Supabase connection strings percent-encode username/password (they contain
// project-ref dots and generated password chars); decode both before handing
// them to psql/libpq, which expect the literal values.
export function psqlInvocation(dbUrl: string, filePath: string): PsqlInvocation {
  const url = new URL(dbUrl);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const port = url.port || "5432";
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres";

  const env: Record<string, string> = { PGPASSWORD: password };
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;

  return {
    args: ["-h", url.hostname, "-p", port, "-U", user, "-d", database, "-f", filePath],
    env,
  };
}
