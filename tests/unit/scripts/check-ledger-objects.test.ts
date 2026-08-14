import { describe, expect, it } from "vitest";
import {
  formatDivergence,
  materializeRoutineIdentities,
  parseMigrations,
  parseRoutineEvents,
  reconcile,
  type RoutineArgument,
} from "../../../scripts/check-ledger-objects";

function resolver(types: Record<string, number>): (argument: RoutineArgument) => Promise<number> {
  return async (argument) => {
    for (const candidate of argument.typeCandidates) {
      if (types[candidate] !== undefined) return types[candidate];
    }
    throw new Error(`unresolved test type: ${argument.declaration}`);
  };
}

describe("parseRoutineEvents", () => {
  it("lexes modes, defaults, quoted types, and function bodies without inventing routines", () => {
    const events = parseRoutineEvents(`
      CREATE OR REPLACE FUNCTION "Audit"."Lookup"(
        IN p_ids int4[],
        p_label varchar(20) DEFAULT 'a,b(c)',
        p_escape text DEFAULT E'a\\'b,CREATE FUNCTION public.fake_escape(uuid)',
        p_score float(20) = 1,
        INOUT p_state "Audit"."State",
        OUT p_debug text,
        VARIADIC p_tags text[] DEFAULT $value$a,b(default)$value$
      ) RETURNS TABLE (ignored text)
      LANGUAGE sql AS $body$
        SELECT 'CREATE FUNCTION public.fake(text)';
      $body$;
    `, "7");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "create", schema: "Audit", name: "Lookup", migration: "7" });
    expect(events[0]?.arguments.map((argument) => argument.typeCandidates.at(-1))).toEqual([
      "int4[]",
      "varchar(20)",
      "text",
      "float(20)",
      '"Audit"."State"',
      "text[]",
    ]);
  });

  it("fails loud on unterminated quoted constructs", () => {
    expect(() => parseRoutineEvents("CREATE FUNCTION public.bad(p text DEFAULT 'unterminated)", "9"))
      .toThrow(/unterminated string literal/);
    expect(() => parseRoutineEvents("/* unterminated", "9"))
      .toThrow(/unterminated block comment/);
    expect(() => parseRoutineEvents("CREATE FUNCTION \"unterminated", "9"))
      .toThrow(/unterminated quoted identifier/);
    expect(() => parseRoutineEvents("CREATE FUNCTION public.bad() AS $body$ unterminated", "9"))
      .toThrow(/unterminated dollar-quoted string/);
  });

  it("retains schema-qualified, %TYPE, and multidimensional source declarations", () => {
    const [event] = parseRoutineEvents(`
      CREATE FUNCTION public.resolve(
        p_domain app.email_domain,
        p_composite "App"."Payload",
        p_column public.accounts.email%TYPE,
        p_matrix text[][]
      ) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
    `, "8");

    expect(event?.arguments.map((argument) => argument.typeCandidates.at(-1))).toEqual([
      "app.email_domain",
      '"App"."Payload"',
      "public.accounts.email%TYPE",
      "text[][]",
    ]);
  });

  it("nets overload siblings and exact drops by resolved input OID vectors", async () => {
    const ledger = await materializeRoutineIdentities(parseMigrations([{ version: "9", sql: `
      CREATE FUNCTION public.lookup(uuid) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
      CREATE FUNCTION public.lookup(text) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
      DROP FUNCTION public.lookup(uuid);
    ` }]), resolver({ uuid: 2950, text: 25 }));

    expect(ledger.expected).toEqual([
      { kind: "function", schema: "public", name: "lookup", identityArgs: "text", identityArgOids: [25], migration: "9" },
    ]);
  });
});

describe("parseMigrations", () => {
  it("ignores create and drop text inside function and DO bodies", () => {
    const ledger = parseMigrations([{ version: "1", sql: `
      CREATE TABLE public.kept (id uuid);
      CREATE FUNCTION public.mutate_ledger() RETURNS void LANGUAGE plpgsql AS $function$
      BEGIN
        CREATE TABLE public.from_function (id uuid);
        DROP TABLE public.kept;
      END
      $function$;
      DO $block$
      BEGIN
        CREATE TABLE public.from_do (id uuid);
        DROP TABLE public.kept;
        EXECUTE 'CREATE TABLE public.from_execute (id uuid)';
        EXECUTE 'DROP TABLE public.kept';
      END
      $block$;
    ` }]);

    expect(ledger.expected).toEqual([
      { kind: "table", schema: "public", name: "kept", migration: "1" },
    ]);
  });

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

  it("tracks enum values and named schema objects without parsing CREATE TABLE columns", async () => {
    const ledger = await materializeRoutineIdentities(parseMigrations([{ version: "7", sql: `
      CREATE TYPE app.status AS ENUM ('new');
      ALTER TYPE app.status ADD VALUE 'ready';
      CREATE TABLE app.items (inner_column text);
      CREATE OR REPLACE VIEW app.current_items AS SELECT * FROM app.items;
      CREATE OR REPLACE FUNCTION app.refresh_items() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
    ` }]), resolver({}));

    expect(ledger.expected).toEqual(expect.arrayContaining([
      { kind: "enum_value", schema: "app", name: "ready", parent: "status", migration: "7" },
      { kind: "function", schema: "app", name: "refresh_items", identityArgs: "", identityArgOids: [], migration: "7" },
      { kind: "table", schema: "app", name: "items", migration: "7" },
      { kind: "type", schema: "app", name: "status", migration: "7" },
      { kind: "view", schema: "app", name: "current_items", migration: "7" },
    ]));
    expect(ledger.expected).not.toContainEqual(expect.objectContaining({ kind: "column", name: "inner_column" }));
  });

  it("keeps function overloads distinct and drops only the named signature", async () => {
    const ledger = await materializeRoutineIdentities(parseMigrations([{ version: "1", sql: `
      CREATE FUNCTION public.lookup(p_id uuid) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
      CREATE FUNCTION public.lookup(p_id text DEFAULT '') RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
      DROP FUNCTION public.lookup(uuid);
    ` }]), resolver({ uuid: 2950, text: 25 }));

    expect(ledger.expected).toEqual([
      { kind: "function", schema: "public", name: "lookup", identityArgs: "text", identityArgOids: [25], migration: "1" },
    ]);
  });

  it("matches array aliases and typmod types without conflating distinct signatures", async () => {
    const ledger = await materializeRoutineIdentities(parseMigrations([{ version: "1", sql: `
      CREATE FUNCTION public.lookup(p_ids int4[], p_code varchar(20))
      RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
    ` }]), resolver({ "int4[]": 1007, "varchar(20)": 1043 }));

    expect(ledger.expected).toEqual([
      {
        kind: "function",
        schema: "public",
        name: "lookup",
        identityArgs: "int4[], varchar(20)",
        identityArgOids: [1007, 1043],
        migration: "1",
      },
    ]);
    expect(reconcile(ledger, [{
      kind: "function",
      schema: "public",
      name: "lookup",
      identityArgs: "integer[], character varying",
      identityArgOids: [1007, 1043],
    }], []).missing).toEqual([]);
    expect(reconcile(ledger, [{
      kind: "function",
      schema: "public",
      name: "lookup",
      identityArgs: "bigint[], character varying",
      identityArgOids: [1016, 1043],
    }], []).missing).toEqual(ledger.expected);
  });

  it("removes enum values when their type is dropped", () => {
    const ledger = parseMigrations([{ version: "1", sql: `
      CREATE TYPE public.status AS ENUM ('new');
      ALTER TYPE public.status ADD VALUE 'ready';
      DROP TYPE public.status;
    ` }]);

    expect(ledger.expected).toEqual([]);
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

  it("reports a missing overload when the catalog contains only its sibling", async () => {
    const ledger = await materializeRoutineIdentities(parseMigrations([{ version: "1", sql: `
      CREATE FUNCTION public.lookup(p_id uuid) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
      CREATE FUNCTION public.lookup(p_id text) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
    ` }]), resolver({ uuid: 2950, text: 25 }));
    const result = reconcile(ledger, [
      { kind: "function", schema: "public", name: "lookup", identityArgs: "uuid", identityArgOids: [2950] },
    ], []);

    expect(result.missing).toEqual([
      { kind: "function", schema: "public", name: "lookup", identityArgs: "text", identityArgOids: [25], migration: "1" },
    ]);
  });
});
