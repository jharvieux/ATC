// #1849 — db-reset.ts previously built a shell string `psql "$DB_RESET_PSQL_URL" ...`;
// /bin/sh expands the var while constructing psql's own argv, so the raw
// credential still landed in psql's `ps`-visible command line even though
// node's own argv never showed it. psqlInvocation() maps a connection URL to
// a discrete execFileSync argv array plus a PGPASSWORD env var instead — the
// password must never appear as an array element, only as an env value.

import { describe, it, expect } from "vitest";
import { psqlInvocation } from "../../../scripts/lib/psql-invocation";

describe("psqlInvocation", () => {
  it("never places the password in the argv array", () => {
    const { args } = psqlInvocation(
      "postgres://postgres:s3cr3tpass@db.abcxyz.supabase.co:5432/postgres",
      "/migrations/0001_init.sql",
    );
    expect(args.join(" ")).not.toContain("s3cr3tpass");
  });

  it("passes the password only via PGPASSWORD", () => {
    const { env } = psqlInvocation(
      "postgres://postgres:s3cr3tpass@db.abcxyz.supabase.co:5432/postgres",
      "/migrations/0001_init.sql",
    );
    expect(env.PGPASSWORD).toBe("s3cr3tpass");
  });

  it("maps host, port, user, database, and file into discrete argv elements", () => {
    const { args } = psqlInvocation(
      "postgres://postgres:pw@db.abcxyz.supabase.co:5432/postgres",
      "/migrations/0001_init.sql",
    );
    expect(args).toEqual([
      "-h",
      "db.abcxyz.supabase.co",
      "-p",
      "5432",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-f",
      "/migrations/0001_init.sql",
    ]);
  });

  it("defaults to port 5432 when the URL omits a port", () => {
    const { args } = psqlInvocation("postgres://postgres:pw@db.abcxyz.supabase.co/postgres", "/f.sql");
    expect(args).toContain("5432");
  });

  it("decodes percent-encoded username and password (Supabase pooler URLs encode both)", () => {
    // Supabase pooler usernames look like postgres.<project-ref>, and the
    // generated password can contain chars that get percent-encoded in the URL.
    const { args, env } = psqlInvocation(
      "postgres://postgres.abcxyz%2Bfoo:p%40ss%2Fw0rd@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
      "/f.sql",
    );
    expect(args).toContain("postgres.abcxyz+foo");
    expect(env.PGPASSWORD).toBe("p@ss/w0rd");
  });

  it("maps a sslmode query param to PGSSLMODE", () => {
    const { env } = psqlInvocation("postgres://postgres:pw@db.abcxyz.supabase.co:5432/postgres?sslmode=require", "/f.sql");
    expect(env.PGSSLMODE).toBe("require");
  });

  it("omits PGSSLMODE when the URL carries no sslmode param", () => {
    const { env } = psqlInvocation("postgres://postgres:pw@db.abcxyz.supabase.co:5432/postgres", "/f.sql");
    expect(env.PGSSLMODE).toBeUndefined();
  });
});
