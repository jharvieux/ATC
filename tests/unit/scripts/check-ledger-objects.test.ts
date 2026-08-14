import { describe, expect, it } from "vitest";
import { formatDivergence, parseMigrations, reconcile } from "../../../scripts/check-ledger-objects";

describe("parseMigrations", () => {
  it("uses migration order and removes every dependent object when a table is dropped", () => {
    const ledger = parseMigrations([
      {
        version: "20260101000000",
        sql: `
          CREATE TABLE public.jobs (id uuid);
          ALTER TABLE public.jobs ADD COLUMN state text;
          ALTER TABLE public.jobs ADD CONSTRAINT jobs_state_check CHECK (state <> '');
          CREATE INDEX jobs_state_idx ON public.jobs (state);
          CREATE TRIGGER jobs_touch BEFORE UPDATE ON public.jobs EXECUTE FUNCTION public.touch();
        `,
      },
      { version: "20260102000000", sql: "DROP TABLE public.jobs;" },
    ]);

    expect(ledger.expected).toEqual([]);
    expect([...ledger.mentionedPublicTables]).toEqual(["jobs"]);
  });

  it("lets the last create or drop event win", () => {
    const ledger = parseMigrations([
      { version: "1", sql: "CREATE TABLE public.alpha (id uuid);" },
      { version: "2", sql: "DROP TABLE public.alpha; CREATE TABLE public.alpha (id uuid);" },
      { version: "3", sql: "ALTER TABLE public.alpha ADD COLUMN note text;" },
      { version: "4", sql: "ALTER TABLE public.alpha DROP COLUMN note;" },
    ]);

    expect(ledger.expected).toEqual([
      { kind: "table", schema: "public", name: "alpha", migration: "2" },
    ]);
  });

  it("tracks enum values and named schema objects without parsing CREATE TABLE columns", () => {
    const ledger = parseMigrations([{ version: "7", sql: `
      CREATE TYPE app.status AS ENUM ('new');
      ALTER TYPE app.status ADD VALUE 'ready';
      CREATE TABLE app.items (inner_column text);
      CREATE OR REPLACE VIEW app.current_items AS SELECT * FROM app.items;
      CREATE OR REPLACE FUNCTION app.refresh_items() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
    ` }]);

    expect(ledger.expected).toEqual(expect.arrayContaining([
      { kind: "enum_value", schema: "app", name: "ready", parent: "status", migration: "7" },
      { kind: "function", schema: "app", name: "refresh_items", migration: "7" },
      { kind: "table", schema: "app", name: "items", migration: "7" },
      { kind: "type", schema: "app", name: "status", migration: "7" },
      { kind: "view", schema: "app", name: "current_items", migration: "7" },
    ]));
    expect(ledger.expected).not.toContainEqual(expect.objectContaining({ kind: "column", name: "inner_column" }));
  });
});

describe("reconcile", () => {
  it("reports exact missing objects with their source migration and out-of-band public tables", () => {
    const ledger = parseMigrations([{ version: "20260704000000", sql: `
      CREATE TABLE public.tenants (id uuid);
      ALTER TABLE public.tenants ADD COLUMN review_submitted_at timestamptz;
    ` }]);
    const result = reconcile(
      ledger,
      [{ kind: "table", schema: "public", name: "tenants" }],
      ["tenants", "manual_table"],
    );

    expect(result).toEqual({
      missing: [{
        kind: "column",
        schema: "public",
        name: "review_submitted_at",
        parent: "tenants",
        migration: "20260704000000",
      }],
      outOfBandTables: ["manual_table"],
    });
    expect(formatDivergence("main", result)).toBe([
      "[main] LEDGER OBJECT DRIFT DETECTED",
      "  MISSING column public.tenants.review_submitted_at (20260704000000)",
      "  OUT-OF-BAND table public.manual_table",
    ].join("\n"));
  });

  it("turns green only when both missing and reverse-direction divergence are absent", () => {
    const ledger = parseMigrations([{ version: "1", sql: "CREATE TABLE public.tenants (id uuid);" }]);
    expect(reconcile(ledger, [{ kind: "table", schema: "public", name: "tenants" }], ["tenants"]))
      .toEqual({ missing: [], outOfBandTables: [] });
  });
});
