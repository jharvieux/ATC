// Unit tests — mocked-tenant-test guard (Harvey Tier-1 port, refs #2028).
// Intent: a test that CLAIMS isolation coverage while mocking the Supabase
// client can never observe an RLS regression — the guard must catch that
// combination and ONLY that combination (mock without claim, claim without
// mock, and partial mocks must all stay silent).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  derivePostgresMigrationProvenance,
  findMockedTenantTests,
  loadBaseline,
  postgresResourcesMatchReviewedProvenance,
  walk,
} from "../../../scripts/check-mocked-tenant-tests";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = path.join(ROOT, "scripts/check-mocked-tenant-tests.ts");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");

const F = "apps/main/test/unit/notes.test.ts";
const EMPTY = new Map<string, string>();
const RLS_FILE = "apps/main/test/integration/rls.test.ts";
const RLS_TEST = "RLS integration bookings: userB cannot SELECT tenantA rows";
const RLS_RESOURCE = "table:public.bookings";
const REAL_DB_COVERAGE = `
import { createClient } from "@supabase/supabase-js";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
const DB_URL = process.env.SUPABASE_DB_URL;
describe("RLS integration", () => {
  it("bookings: userB cannot SELECT tenantA rows", async () => {
    const db = createClient("https://db.example.test", "anon-key");
    await assertIsolationQuery({
      query: () => db.from("bookings").select("id"),
      allowedIds: [],
      deniedIds: ["booking-a"],
    });
  });
});
`;
const pointer = (testName = RLS_TEST, resources = RLS_RESOURCE) =>
  `// @rls-covered-by resources=${resources} target=${RLS_FILE}#${testName}`;

const MUTATED_LOADER_FACTORIES = [
  ["direct reassignment", "loader = fake;", "loader"],
  ["conditional reassignment", "process.env.USE_FAKE ? loader = fake : 0;", "loader"],
  ["logical expression reassignment", "process.env.USE_FAKE && (loader = fake);", "loader"],
  ["logical AND assignment", "loader &&= fake;", "loader"],
  ["logical OR assignment", "loader ||= fake;", "loader"],
  ["nullish assignment", "loader ??= fake;", "loader"],
  ["array destructuring assignment", "[loader] = [fake];", "loader"],
  ["object destructuring assignment", "({ load: loader } = { load: fake });", "loader"],
  ["nested mutator closure", "const mutate = () => { loader = fake; }; mutate();", "loader"],
  ["nested mutator function", "function mutate() { loader = fake; } mutate();", "loader"],
  ["reassigned alias funnel", "let alias = loader; alias = fake;", "alias"],
] as const;

const PROVEN_LOADER_FACTORIES = [
  ["immutable aliases", "const alias = loader; const alias2 = alias;", "alias2"],
  ["restored loader", "const pristine = loader; loader = fake; loader = pristine;", "loader"],
  [
    "branch-restored loader",
    "const pristine = loader; if (process.env.USE_FAKE) loader = fake; loader = pristine;",
    "loader",
  ],
] as const;

const MUTATOR_CALL_FACTORIES = [
  ["arrow IIFE", "(() => { loader = fake; })();"],
  ["function IIFE", "(function () { loader = fake; })();"],
  ["assignment callee", "(loader = fake)();"],
  ["Function.call", "const mutate = () => { loader = fake; }; mutate.call(undefined);"],
  ["Function.apply", "const mutate = () => { loader = fake; }; mutate.apply(undefined, []);"],
  ["direct Function.call", "(function () { loader = fake; }).call(undefined);"],
  ["object method", "const mutators = { mutate() { loader = fake; } }; mutators.mutate();"],
  [
    "destructured method alias",
    "const mutators = { mutate() { loader = fake; } }; const { mutate } = mutators; mutate();",
  ],
  [
    "computed method through receiver alias",
    'const mutators = { ["mutate"]() { loader = fake; } }; const receiver = mutators; receiver["mutate"]();',
  ],
  ["hoisted function", "mutate(); function mutate() { loader = fake; }"],
  ["immutable function alias", "const mutate = () => { loader = fake; }; const alias = mutate; alias();"],
  ["unknown callback runner", "runNow(() => { loader = fake; });"],
  [
    "aliased unknown callback",
    "const mutate = () => { loader = fake; }; const alias = mutate; runNow(alias);",
  ],
] as const;

const SAFE_CALL_FACTORIES = [
  ["restoring IIFE", "const pristine = loader; (() => { loader = fake; loader = pristine; })();"],
  ["non-mutating method", "const helpers = { run() { return 42; } }; helpers.run();"],
  ["non-mutating unknown callback", "runNow(() => 42);"],
  ["uninvoked mutator", "const mutate = () => { loader = fake; }; void mutate;"],
  ["shadowed callback parameter", "runNow((loader) => { loader = fake; });"],
  ["shadowed function parameter", "function mutate(loader) { loader = fake; } mutate(fake);"],
  [
    "overwritten callable alias",
    "const mutate = () => { loader = fake; }; let alias = mutate; alias = () => 42; alias();",
  ],
  [
    "resolved no-op runner",
    "const mutate = () => { loader = fake; }; const run = (_callback) => 42; run(mutate);",
  ],
] as const;

const claimTest = (body: string) => `
import { describe, it, vi } from "vitest";
${body}
describe("notes route", () => {
  it("enforces tenant isolation on the list query", async () => {});
});
`;

const annotationErrorFor = (coverageTarget: string, resources = RLS_RESOURCE): string | undefined => {
  const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
    '  it("enforces tenant isolation on the list query", async () => {});',
    `  ${pointer(RLS_TEST, resources)}\n  it("enforces tenant isolation on the list query", async () => {});`,
  );
  return findMockedTenantTests(F, source, new Map([[RLS_FILE, coverageTarget]]))[0]?.annotationError;
};

const postgresAnnotationErrorFor = (query: string, setup = "", resources = RLS_RESOURCE): string | undefined => annotationErrorFor(`
import postgres from "postgres";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
const DB_URL = process.env.SUPABASE_DB_URL;
describe("RLS integration", () => {
  it("bookings: userB cannot SELECT tenantA rows", async () => {
    const sql = postgres(DB_URL!);
    ${setup}
    await assertIsolationQuery({ query: ${query}, allowedIds: [], deniedIds: ["booking-a"] });
  });
});
`, resources);

describe("raw Postgres migration provenance", () => {
  const derive = (...sql: string[]) => derivePostgresMigrationProvenance(
    sql.map((contents, index) => ({ file: `${String(index + 1).padStart(4, "0")}.sql`, sql: contents })),
  );
  const repoMigrations = (target: "main" | "rag") => {
    const dir = path.join(ROOT, "apps", target, "supabase", "migrations");
    return readdirSync(dir)
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => ({ file, sql: readFileSync(path.join(dir, file), "utf8") }));
  };
  const reviewedBookingsPolicy = "CREATE POLICY bookings_select_policy ON public.bookings\n" +
    "  FOR SELECT\n" +
    "  USING (auth_user_in_tenant(tenant_id));";
  const reconstructedUuidEq = "CREATE OR REPLACE FUNCTION pg_catalog.uuid_eq(uuid, uuid) " +
    "RETURNS boolean AS 'uuid_eq' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;";
  const reconstructedUuidCmp = "CREATE OR REPLACE FUNCTION pg_catalog.uuid_cmp(uuid, uuid) " +
    "RETURNS integer AS 'uuid_cmp' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;";

  it("derives base-table relation kinds without accepting view or catalog-backed lookalikes", () => {
    const provenance = derive(`
      CREATE TABLE public.base_rows (id uuid);
      CREATE VIEW public.view_rows AS SELECT id FROM public.base_rows;
      CREATE MATERIALIZED VIEW public.materialized_rows AS SELECT id FROM public.base_rows;
      CREATE FOREIGN TABLE public.foreign_rows (id uuid) SERVER remote_server;
      CREATE TABLE public.partitioned_rows (id uuid) PARTITION BY HASH (id);
    `);
    expect(Object.fromEntries(provenance.relations)).toEqual({
      "public.base_rows": "table",
      "public.foreign_rows": "foreign_table",
      "public.materialized_rows": "materialized_view",
      "public.partitioned_rows": "partitioned_table",
      "public.view_rows": "view",
    });
  });

  it("binds a function to its effective replacement, not unrelated migration bytes", () => {
    const original = `CREATE FUNCTION public.read_rows(p_id uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT p_id $$;`;
    const replaced = `CREATE OR REPLACE FUNCTION public.read_rows(p_id uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;`;
    const before = derive(original);
    const unrelated = derive(original, "CREATE TABLE public.unrelated (id uuid);");
    const after = derive(original, replaced);
    const hash = before.functions.get("public.read_rows")?.get("uuid");
    expect(hash).toBeDefined();
    expect(unrelated.functions.get("public.read_rows")?.get("uuid")).toBe(hash);
    expect(after.functions.get("public.read_rows")?.get("uuid")).not.toBe(hash);
  });

  it("retains overload identity and removes only the explicitly dropped signature", () => {
    const overloaded = derive(`
      CREATE FUNCTION public.read_rows(p_id uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT p_id $$;
      CREATE FUNCTION public.read_rows(p_id text) RETURNS text LANGUAGE sql AS $$ SELECT p_id $$;
    `);
    expect([...overloaded.functions.get("public.read_rows")!.keys()].sort()).toEqual(["text", "uuid"]);
    const resolved = derive(`
      CREATE FUNCTION public.read_rows(p_id uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT p_id $$;
      CREATE FUNCTION public.read_rows(p_id text) RETURNS text LANGUAGE sql AS $$ SELECT p_id $$;
      DROP FUNCTION public.read_rows(text);
    `);
    expect([...resolved.functions.get("public.read_rows")!.keys()]).toEqual(["uuid"]);
  });

  it("tracks effective RLS and policy definitions while ignoring unrelated objects", () => {
    const original = `
      CREATE TABLE public.base_rows (id uuid);
      ALTER TABLE public.base_rows ENABLE ROW LEVEL SECURITY;
      CREATE POLICY base_rows_select ON public.base_rows FOR SELECT USING (id IS NOT NULL);
    `;
    const before = derive(original);
    const unrelated = derive(original, "CREATE TABLE public.unrelated (id uuid);");
    const replaced = derive(original, `
      DROP POLICY base_rows_select ON public.base_rows;
      CREATE POLICY base_rows_select ON public.base_rows FOR SELECT USING (false);
    `);
    const policyHash = before.policies.get("public.base_rows")?.get("base_rows_select")?.definitionHash;
    expect(before.rlsEnabled.get("public.base_rows")).toBe(true);
    expect(unrelated.policies.get("public.base_rows")?.get("base_rows_select")?.definitionHash).toBe(policyHash);
    expect(replaced.policies.get("public.base_rows")?.get("base_rows_select")?.definitionHash).not.toBe(policyHash);
    expect(derive(original, "ALTER TABLE public.base_rows DISABLE ROW LEVEL SECURITY;").rlsEnabled.get("public.base_rows")).toBe(false);
  });

  it("does not derive objects from comments, strings, or function bodies", () => {
    const provenance = derive(`
      -- CREATE VIEW public.comment_view AS SELECT 1;
      CREATE FUNCTION public.read_rows() RETURNS text LANGUAGE plpgsql AS $body$
      BEGIN
        RETURN 'CREATE FOREIGN TABLE public.string_rows (id uuid);';
      END;
      $body$;
      CREATE TABLE public.base_rows (id uuid);
    `);
    expect([...provenance.relations]).toEqual([["public.base_rows", "table"]]);
    expect([...provenance.functions.get("public.read_rows")!.keys()]).toEqual([""]);
  });

  it("fails closed on unterminated migration syntax", () => {
    expect(() => derive("CREATE FUNCTION public.read_rows() RETURNS text AS $$ SELECT 1"))
      .toThrow(/unterminated dollar-quoted/);
  });

  it("removes a reviewed relation name when the table is renamed", () => {
    const provenance = derive(`
      CREATE TABLE public.base_rows (id uuid);
      ALTER TABLE public.base_rows ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.base_rows RENAME TO renamed_rows;
    `);
    expect(provenance.relations.has("public.base_rows")).toBe(false);
    expect(provenance.relations.get("public.renamed_rows")).toBe("table");
    expect(provenance.rlsEnabled.get("public.renamed_rows")).toBe(true);
  });

  it("removes every old relation key after multi-drop or schema transfer", () => {
    const moved = derive(`
      CREATE TABLE public.base_rows (id uuid);
      ALTER TABLE public.base_rows SET SCHEMA private;
    `);
    expect([...moved.relations]).toEqual([["private.base_rows", "table"]]);
    const dropped = derive(`
      CREATE TABLE public.first_rows (id uuid);
      CREATE TABLE public.second_rows (id uuid);
      DROP TABLE public.first_rows, public.second_rows CASCADE;
    `);
    expect([...dropped.relations]).toEqual([]);
  });

  it.each([
    ["view", "CREATE VIEW public.bookings AS SELECT NULL::uuid AS id"],
    ["materialized view", "CREATE MATERIALIZED VIEW public.bookings AS SELECT NULL::uuid AS id"],
    ["foreign table", "CREATE FOREIGN TABLE public.bookings (id uuid) SERVER remote_server"],
    ["partitioned table", "CREATE TABLE public.bookings (id uuid) PARTITION BY HASH (id)"],
  ])("rejects a reviewed table after its effective relation kind becomes %s", (_kind, replacement) => {
    const migrations = repoMigrations("main");
    const provenance = derivePostgresMigrationProvenance([
      ...migrations,
      { file: "zzzz_relation.sql", sql: `DROP TABLE public.bookings; ${replacement};` },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(false);
  });

  it("accepts reviewed objects across an unrelated migration", () => {
    const migrations = repoMigrations("main");
    const provenance = derivePostgresMigrationProvenance([
      ...migrations,
      { file: "zzzz_unrelated.sql", sql: "CREATE TABLE public.unrelated_provenance_probe (id uuid);" },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(true);
  });

  it.each([
    ["RLS disable", "ALTER TABLE public.bookings DISABLE ROW LEVEL SECURITY;"],
    ["SELECT policy replacement", "DROP POLICY bookings_select_policy ON public.bookings; CREATE POLICY bookings_select_policy ON public.bookings FOR SELECT USING (false);"],
    ["SELECT rewrite rule", "CREATE RULE bookings_read_effect AS ON SELECT TO public.bookings DO INSTEAD NOTHING;"],
    ["policy ambiguity", "ALTER POLICY bookings_select_policy ON public.bookings USING (false);"],
    ["policy function replacement", "CREATE OR REPLACE FUNCTION public.auth_user_in_tenant(target_tenant_id uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;"],
    ["policy function overload", "CREATE FUNCTION public.auth_user_in_tenant(target_tenant_id text) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;"],
    ["policy function ALTER", "ALTER FUNCTION public.auth_user_in_tenant(uuid) RENAME TO replaced_auth_user_in_tenant;"],
  ])("rejects reviewed table provenance after %s", (_shape, sql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      { file: "zzzz_effect.sql", sql },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(false);
  });

  it.each([
    ["ALTER ROUTINE", "ALTER ROUTINE public.auth_user_in_tenant(uuid) SET search_path = public, pg_catalog;"],
    ["comment-separated ALTER ROUTINE", "ALTER/*probe*/ ROUTINE public.auth_user_in_tenant(uuid) SET search_path = public, pg_catalog;"],
    ["DROP ROUTINE", "DROP ROUTINE public.auth_user_in_tenant(uuid);"],
    ["named DROP FUNCTION argument", "DROP FUNCTION public.auth_user_in_tenant(target_tenant_id uuid);"],
    ["qualified DROP FUNCTION argument", "DROP FUNCTION public.auth_user_in_tenant(pg_catalog.uuid);"],
    ["quoted qualified DROP FUNCTION argument", "DROP FUNCTION \"public\".\"auth_user_in_tenant\"(\"pg_catalog\".\"uuid\");"],
    ["multi-object DROP ROUTINE", "DROP ROUTINE public.unrelated_routine(), public.auth_user_in_tenant(uuid);"],
    ["procedure overload", "CREATE PROCEDURE public.auth_user_in_tenant(text) LANGUAGE sql AS $$ SELECT 1 $$;"],
    ["aggregate overload", "CREATE AGGREGATE public.auth_user_in_tenant(text) (SFUNC = textcat, STYPE = text, INITCOND = '');"],
  ])("rejects reviewed policy-function provenance after %s", (_shape, sql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      { file: "zzzz_routine_alias.sql", sql },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(false);
  });

  it("accepts an exact reviewed routine and policy recreated with a fresh binding", () => {
    const migrations = repoMigrations("main");
    const helperMigration = migrations.find(({ file }) => file === "20260521120001_rls_helper_functions.sql");
    expect(helperMigration).toBeDefined();
    const provenance = derivePostgresMigrationProvenance([
      ...migrations,
      { file: "zzzza_drop.sql", sql: "DROP POLICY bookings_select_policy ON public.bookings; DROP ROUTINE public.auth_user_in_tenant(uuid);" },
      { file: "zzzzb_recreate.sql", sql: helperMigration!.sql },
      { file: "zzzzc_policy.sql", sql: reviewedBookingsPolicy },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(true);
  });

  it("rejects a byte-identical reviewed policy rebound through session search_path", () => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      {
        file: "zzzz_policy_rebind.sql",
        sql: "CREATE SCHEMA private;\n" +
          "CREATE FUNCTION private.auth_user_in_tenant(target_tenant_id uuid) " +
          "RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;\n" +
          "SET search_path = private, public;\n" +
          "DROP POLICY bookings_select_policy ON public.bookings;\n" +
          reviewedBookingsPolicy,
      },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(false);
  });

  it("rejects a byte-identical reviewed policy rebound through default $user search_path", () => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      {
        file: "zzzz_policy_user_rebind.sql",
        sql: "CREATE SCHEMA postgres;\n" +
          "CREATE FUNCTION postgres.auth_user_in_tenant(target_tenant_id uuid) " +
          "RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;\n" +
          "DROP POLICY bookings_select_policy ON public.bookings;\n" +
          reviewedBookingsPolicy,
      },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(false);
  });

  it("accepts default $user policy resolution when only an unrelated schema shadows the routine", () => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      {
        file: "zzzz_policy_user_control.sql",
        sql: "CREATE SCHEMA private;\n" +
          "CREATE FUNCTION private.auth_user_in_tenant(target_tenant_id uuid) " +
          "RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;\n" +
          "DROP POLICY bookings_select_policy ON public.bookings;\n" +
          reviewedBookingsPolicy,
      },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(true);
  });

  it.each([
    ["SET LOCAL", "SET LOCAL search_path = private, public;"],
    ["set_config", "SELECT set_config('search_path', 'private,public', true);"],
  ])("rejects reviewed policy OID rebinding through %s", (_shape, setPath) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      {
        file: "zzzz_policy_rebind.sql",
        sql: "CREATE SCHEMA private;\n" +
          "CREATE FUNCTION private.auth_user_in_tenant(target_tenant_id uuid) " +
          "RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;\n" +
          `${setPath}\n` +
          "DROP POLICY bookings_select_policy ON public.bookings;\n" +
          reviewedBookingsPolicy,
      },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(false);
  });

  it("accepts a reviewed policy recreated after search_path is reset", () => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      {
        file: "zzzz_policy_reset.sql",
        sql: "CREATE SCHEMA private;\n" +
          "CREATE FUNCTION private.auth_user_in_tenant(target_tenant_id uuid) " +
          "RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;\n" +
          "SET search_path = private, public;\n" +
          "RESET search_path;\n" +
          "DROP POLICY bookings_select_policy ON public.bookings;\n" +
          reviewedBookingsPolicy,
      },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(true);
  });

  it("rejects reviewed operator provenance after a search-path override", () => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      {
        file: "zzzz_operator.sql",
        sql: `
          CREATE OPERATOR public.= (
            LEFTARG = uuid,
            RIGHTARG = uuid,
            FUNCTION = pg_catalog.uuid_eq
          );
          ALTER ROLE authenticated SET search_path = public, pg_catalog;
        `,
      },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(false);
  });

  it.each([
    ["role", "ALTER ROLE authenticated SET search_path = public, pg_catalog;"],
    ["role in database", "ALTER ROLE authenticated IN DATABASE postgres SET search_path = public, pg_catalog;"],
    ["database", "ALTER DATABASE postgres SET search_path = public, pg_catalog;"],
    ["system", "ALTER SYSTEM SET search_path = public, pg_catalog;"],
  ])("rejects a reviewed query after a persistent %s search_path override", (_shape, sql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      { file: "zzzz_runtime_path.sql", sql },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(false);
  });

  it.each([
    ["reset relevant role", "ALTER ROLE authenticated SET search_path = public, pg_catalog; ALTER ROLE authenticated RESET search_path;"],
    ["unrelated role", "ALTER ROLE reporting_user SET search_path = private, public;"],
  ])("accepts reviewed provenance after %s search_path configuration", (_shape, sql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      { file: "zzzz_runtime_path_control.sql", sql },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(true);
  });

  it.each([
    ["SUPERUSER", "ALTER ROLE authenticated SUPERUSER;"],
    ["ordered BYPASSRLS", "ALTER USER authenticated WITH LOGIN NOSUPERUSER BYPASSRLS;"],
    ["quoted comment-separated role", "ALTER/*probe*/ USER \"authenticated\" WITH BYPASSRLS;"],
    ["service-role RLS removal", "ALTER ROLE service_role NOBYPASSRLS;"],
    ["dangerous final option", "ALTER ROLE authenticated NOBYPASSRLS BYPASSRLS;"],
    ["unresolved current role", "ALTER ROLE CURRENT_USER BYPASSRLS;"],
    ["relevant role rename", "ALTER ROLE authenticated RENAME TO replaced_authenticated;"],
    ["relevant role drop", "DROP USER authenticated;"],
    ["relevant role second in drop list", "DROP ROLE reporting_user, authenticated;"],
    ["resolved current role", "SET ROLE authenticated; ALTER ROLE CURRENT_USER BYPASSRLS;"],
  ])("rejects reviewed provenance after %s authority mutation", (_shape, sql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      { file: "zzzz_role_authority.sql", sql },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(false);
  });

  it.each([
    ["authenticated authority restoration", "ALTER ROLE authenticated BYPASSRLS SUPERUSER; ALTER USER authenticated NOSUPERUSER NOBYPASSRLS;"],
    ["ordered baseline final options", "ALTER ROLE authenticated BYPASSRLS SUPERUSER NOSUPERUSER NOBYPASSRLS;"],
    ["service-role authority restoration", "ALTER USER service_role NOBYPASSRLS; ALTER ROLE service_role NOSUPERUSER BYPASSRLS;"],
    ["idempotent baseline authority", "ALTER ROLE authenticated NOSUPERUSER NOBYPASSRLS; ALTER ROLE service_role NOSUPERUSER BYPASSRLS;"],
    ["unrelated role authority", "ALTER USER reporting_user SUPERUSER BYPASSRLS;"],
    ["quoted keyword role authority", "ALTER ROLE \"CURRENT_USER\" BYPASSRLS; ALTER ROLE \"ALL\" SUPERUSER;"],
  ])("accepts reviewed provenance after exact %s", (_shape, sql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      { file: "zzzz_role_authority_control.sql", sql },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(true);
  });

  it.each([
    ["ALTER USER", "ALTER USER authenticated SET search_path = private, public;"],
    ["role/database crossed by role reset", "ALTER ROLE authenticated IN DATABASE postgres SET search_path = private, public; ALTER ROLE authenticated RESET search_path;"],
    ["database crossed by another database reset", "ALTER DATABASE postgres SET search_path = private, public; ALTER DATABASE template1 RESET search_path;"],
    ["system crossed by role-all reset", "ALTER SYSTEM SET search_path = private, public; ALTER ROLE ALL RESET search_path;"],
    ["role-all crossed by system reset", "ALTER ROLE ALL SET search_path = private, public; ALTER SYSTEM RESET search_path;"],
  ])("rejects reviewed provenance when a %s setting remains effective", (_shape, sql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      { file: "zzzz_runtime_scope.sql", sql },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(false);
  });

  it.each([
    ["role/database", "ALTER USER authenticated IN DATABASE postgres SET search_path = private, public; ALTER ROLE authenticated IN DATABASE postgres RESET ALL;"],
    ["database via role-all alias", "ALTER ROLE ALL IN DATABASE postgres SET search_path = private, public; ALTER DATABASE postgres RESET search_path;"],
    ["system", "ALTER SYSTEM SET search_path = private, public; ALTER SYSTEM RESET search_path;"],
    ["role-all", "ALTER ROLE ALL SET search_path = private, public; ALTER ROLE ALL RESET ALL;"],
    ["unrelated persistent scope", "ALTER USER reporting_user SET search_path = private, public;"],
  ])("accepts reviewed provenance after same-scope %s cleanup", (_shape, sql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      { file: "zzzz_runtime_scope_control.sql", sql },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(true);
  });

  it.each([
    ["SET ROLE", "SET ROLE private_creator;"],
    ["SET LOCAL ROLE", "SET LOCAL ROLE private_creator;"],
    ["string SET ROLE", "SET ROLE 'private_creator';"],
    ["SET SESSION AUTHORIZATION", "SET SESSION AUTHORIZATION 'private_creator';"],
  ])("binds $user to the effective identity after %s", (_shape, identitySql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      {
        file: "zzzz_session_identity.sql",
        sql: `
          CREATE ROLE private_creator;
          CREATE SCHEMA private_creator;
          CREATE OPERATOR CLASS private_creator.evil_uuid_ops FOR TYPE uuid USING btree AS
            OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid),
            OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid);
          ${identitySql}
          SET search_path = "$user", public;
          CREATE INDEX bookings_private_creator_probe ON public.bookings USING btree (id evil_uuid_ops);
        `,
      },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(false);
  });

  it.each([
    ["RESET ROLE", "SET ROLE private_creator; RESET ROLE;"],
    ["SET ROLE NONE", "SET SESSION ROLE private_creator; SET ROLE NONE;"],
    ["RESET SESSION AUTHORIZATION", "SET SESSION AUTHORIZATION private_creator; RESET SESSION AUTHORIZATION;"],
  ])("restores $user before index creation with %s", (_shape, identitySql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      {
        file: "zzzz_session_identity_control.sql",
        sql: `
          CREATE ROLE private_creator;
          CREATE SCHEMA private_creator;
          CREATE OPERATOR CLASS private_creator.evil_uuid_ops FOR TYPE uuid USING btree AS
            OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid),
            OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid);
          ${identitySql}
          SET search_path = "$user", public;
          CREATE INDEX bookings_builtin_identity_probe ON public.bookings USING btree (id uuid_ops);
        `,
      },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(true);
  });

  it.each([
    ["UUID equality implementation replacement", "CREATE OR REPLACE FUNCTION pg_catalog.uuid_eq(uuid, uuid) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT false $$;"],
    ["UUID equality attribute alteration", "ALTER FUNCTION pg_catalog.uuid_eq(uuid, uuid) LEAKPROOF;"],
    ["unqualified UUID comparison alteration", "ALTER FUNCTION uuid_cmp(uuid, uuid) NOT LEAKPROOF;"],
    ["attribute alteration followed by guessed inverse", "ALTER FUNCTION pg_catalog.uuid_eq(uuid, uuid) NOT LEAKPROOF; ALTER FUNCTION pg_catalog.uuid_eq(uuid, uuid) LEAKPROOF;"],
    ["UUID equality implementation drop", "DROP FUNCTION pg_catalog.uuid_eq(uuid, uuid) CASCADE;"],
    ["unqualified UUID equality drop", "DROP FUNCTION uuid_eq(uuid, uuid) CASCADE;"],
    ["creation-path UUID equality replacement", "SET search_path = pg_catalog, public; CREATE OR REPLACE FUNCTION uuid_eq(uuid, uuid) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT false $$;"],
    ["UUID opclass comparison replacement", "CREATE OR REPLACE FUNCTION pg_catalog.uuid_cmp(uuid, uuid) RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT 0 $$;"],
    ["UUID opclass comparison drop", "DROP FUNCTION pg_catalog.uuid_cmp(uuid, uuid) CASCADE;"],
    ["text equality alteration", "ALTER FUNCTION pg_catalog.texteq(text, text) NOT LEAKPROOF;"],
    ["case-insensitive text comparison drop", "DROP FUNCTION pg_catalog.texticlike(text, text) CASCADE;"],
    ["date equality alteration", "ALTER FUNCTION pg_catalog.date_eq(date, date) VOLATILE;"],
    ["UUID sort-support alteration", "ALTER FUNCTION pg_catalog.uuid_sortsupport(internal) PARALLEL RESTRICTED;"],
    ["btree equality-image drop", "DROP FUNCTION pg_catalog.btequalimage(oid) CASCADE;"],
    ["unknown catalog routine creation", "CREATE FUNCTION pg_catalog.unknown_guard_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;"],
    ["quoted catalog procedure replacement", "CREATE OR REPLACE PROCEDURE \"pg_catalog\".unknown_guard_procedure() LANGUAGE sql AS $$ SELECT 1 $$;"],
    ["catalog aggregate creation", "CREATE AGGREGATE pg_catalog.unknown_guard_aggregate(integer) (SFUNC = pg_catalog.int4pl, STYPE = integer);"],
    ["catalog creation through SET SCHEMA", "SET SCHEMA 'pg_catalog'; CREATE FUNCTION unknown_guard_path_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;"],
    ["catalog creation through set_config", "SELECT set_config('search_path', 'pg_catalog, public', false); CREATE FUNCTION unknown_guard_config_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;"],
    ["unresolved creation path", "SELECT set_config('search_path', current_setting('search_path'), false); CREATE FUNCTION unknown_guard_dynamic_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;"],
    ["routine alias without signature", "ALTER ROUTINE pg_catalog.uuid_eq RENAME TO unknown_guard_uuid_eq;"],
    ["catalog destination schema", "CREATE FUNCTION public.unknown_guard_move_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$; ALTER FUNCTION public.unknown_guard_move_probe() SET SCHEMA pg_catalog;"],
    ["catalog procedure second in drop list", "DROP PROCEDURE public.unrelated(), pg_catalog.unknown_guard_procedure() CASCADE;"],
    ["extension catalog routine membership", "ALTER EXTENSION plpgsql DROP FUNCTION pg_catalog.unknown_guard_probe();"],
    ["unparsed Unicode catalog identifier", String.raw`CREATE FUNCTION U&\"pg\005fcatalog\".unknown_guard_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;`],
    ["UUID equality second in drop list", "DROP FUNCTION public.unrelated(), pg_catalog.uuid_eq(uuid, uuid) CASCADE;"],
    ["reviewed equality operator second in drop list", "DROP OPERATOR public.## (uuid, uuid), pg_catalog.= (uuid, uuid) CASCADE;"],
    ["reviewed primary index second in drop list", "DROP INDEX public.unrelated_idx, public.bookings_pkey CASCADE;"],
    ["synthetic equality reconstruction missing catalog attributes", reconstructedUuidEq],
    ["synthetic comparison reconstruction missing catalog attributes", reconstructedUuidCmp],
    ["replacement followed by synthetic equality reconstruction", `CREATE OR REPLACE FUNCTION pg_catalog.uuid_eq(uuid, uuid) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT false $$; ${reconstructedUuidEq}`],
    ["replacement followed by synthetic comparison reconstruction", `CREATE OR REPLACE FUNCTION pg_catalog.uuid_cmp(uuid, uuid) RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT 0 $$; ${reconstructedUuidCmp}`],
    ["synthetic equality followed by malicious replacement", `${reconstructedUuidEq} CREATE OR REPLACE FUNCTION pg_catalog.uuid_eq(uuid, uuid) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT false $$;`],
    ["drop and routine-only recreation", `DROP FUNCTION pg_catalog.uuid_cmp(uuid, uuid) CASCADE; ${reconstructedUuidCmp}`],
  ])("rejects reviewed provenance after %s", (_shape, sql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      { file: "zzzz_catalog_routine.sql", sql },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(false);
  });

  it.each([
    ["text comparison", "ALTER FUNCTION pg_catalog.texticlike(text, text) NOT LEAKPROOF;"],
    ["date equality", "DROP FUNCTION pg_catalog.date_eq(date, date) CASCADE;"],
    ["unknown catalog routine", "CREATE FUNCTION pg_catalog.unknown_rag_guard_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;"],
    ["vector drop/recreation", "DROP EXTENSION vector CASCADE; CREATE EXTENSION IF NOT EXISTS vector;"],
    ["vector alteration/drop/recreation", "ALTER EXTENSION vector UPDATE; DROP EXTENSION vector CASCADE; CREATE EXTENSION IF NOT EXISTS vector;"],
    ["pg_trgm drop/recreation", "DROP EXTENSION pg_trgm CASCADE; CREATE EXTENSION IF NOT EXISTS pg_trgm;"],
  ])("rejects RAG provenance after %s catalog mutation", (_shape, sql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("rag"),
      { file: "zzzz_catalog_routine.sql", sql },
    ]);
    expect(postgresResourcesMatchReviewedProvenance(
      "rag",
      ["table:public.knowledge_chunks", "rpc:public.match_region_itinerary_chunks"],
      provenance,
    )).toBe(false);
  });

  it.each([
    ["unrelated public routine", "CREATE OR REPLACE FUNCTION public.catalog_name_probe(bigint, bigint) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT $1 = $2 $$;"],
    ["unrelated private routine", "CREATE SCHEMA private; CREATE FUNCTION private.catalog_name_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;"],
    ["unrelated public routine lifecycle", "CREATE FUNCTION public.catalog_lifecycle_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$; ALTER FUNCTION public.catalog_lifecycle_probe() VOLATILE; DROP FUNCTION public.catalog_lifecycle_probe();"],
    ["private-path routine creation", "CREATE SCHEMA private; SET search_path = private, public; CREATE FUNCTION catalog_path_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;"],
    ["case-distinct quoted schema routine", "CREATE SCHEMA \"PG_CATALOG\"; CREATE FUNCTION \"PG_CATALOG\".catalog_name_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;"],
    ["unqualified public routine", "CREATE FUNCTION uuid_eq(uuid, uuid) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT false $$;"],
    ["unrelated drop lists", "DROP FUNCTION public.unrelated(), public.also_unrelated(uuid); DROP OPERATOR public.## (uuid, uuid); DROP INDEX public.unrelated_idx; DROP ROLE reporting_user, reporting_admin;"],
  ])("accepts reviewed provenance after %s", (_shape, sql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      { file: "zzzz_catalog_routine_control.sql", sql },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(true);
  });

  it("does not claim a PostgreSQL version or reconstruct core routine DDL", () => {
    const detector = readFileSync(path.join(ROOT, "scripts/check-mocked-tenant-tests.ts"), "utf8");
    expect(detector).not.toMatch(/postgresql-\d+|CREATE OR REPLACE FUNCTION pg_catalog\.uuid_(?:eq|cmp)|LANGUAGE internal/);
  });

  it("accepts a fully removed custom operator dependency graph", () => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      {
        file: "zzzz_catalog_graph_cleanup.sql",
        sql: `
          CREATE FUNCTION public.evil_uuid_eq(uuid, uuid) RETURNS boolean
            LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
          CREATE OPERATOR public.## (
            LEFTARG = uuid, RIGHTARG = uuid, PROCEDURE = public.evil_uuid_eq
          );
          CREATE OPERATOR CLASS public.evil_uuid_ops FOR TYPE uuid USING btree AS
            OPERATOR 3 public.## (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid);
          CREATE INDEX bookings_evil_graph_probe ON public.bookings USING btree (id public.evil_uuid_ops);
          DROP INDEX public.bookings_evil_graph_probe;
          DROP OPERATOR CLASS public.evil_uuid_ops USING btree;
          DROP OPERATOR public.## (uuid, uuid);
          DROP FUNCTION public.evil_uuid_eq(uuid, uuid);
        `,
      },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(true);
  });

  it.each([
    ["relevant operator", "CREATE OPERATOR public.= (LEFTARG = uuid, RIGHTARG = uuid, FUNCTION = pg_catalog.uuid_eq);"],
    ["relevant cast", "DROP CAST (uuid AS text);"],
    ["built-in type shadow", "CREATE DOMAIN public.uuid AS text;"],
    ["new extension", "CREATE EXTENSION IF NOT EXISTS hstore;"],
    ["extension create/drop cycle", "CREATE EXTENSION IF NOT EXISTS hstore; DROP EXTENSION hstore;"],
    ["catalog-schema extension create/drop cycle", "CREATE EXTENSION hstore SCHEMA pg_catalog; DROP EXTENSION hstore;"],
    ["catalog extension drop/recreate/drop cycle", "DROP EXTENSION plpgsql CASCADE; CREATE EXTENSION plpgsql; DROP EXTENSION plpgsql CASCADE;"],
    ["dynamic catalog DDL in DO", "DO $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$;"],
    ["dynamic catalog DDL through called procedure", "CREATE PROCEDURE public.catalog_mutator() LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$; CALL public.catalog_mutator();"],
    ["dynamic catalog DDL through selected function", "CREATE FUNCTION public.catalog_mutator() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$; SELECT public.catalog_mutator();"],
    ["dynamic catalog DDL in a standard single-quoted body", "CREATE FUNCTION public.quoted_mutator() RETURNS integer LANGUAGE plpgsql AS 'BEGIN EXECUTE ''CREATE FUNCTION pg_catalog.quoted_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$''; RETURN 1; END'; SELECT public.quoted_mutator();"],
    ["dynamic catalog DDL through a standard single-quoted wrapper", "CREATE FUNCTION public.catalog_mutator() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN 1; END $body$; CREATE FUNCTION public.quoted_wrapper() RETURNS integer LANGUAGE sql AS 'SELECT public.catalog_mutator()'; SELECT public.quoted_wrapper();"],
    ["invoked unanalysable escape-string body", "CREATE FUNCTION public.escape_body() RETURNS integer LANGUAGE plpgsql AS E'BEGIN RETURN 1; END'; SELECT public.escape_body();"],
    ["dynamic wrapper dependency after callee recreation", "CREATE FUNCTION public.rebound_mutator() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.rebound_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN 1; END $body$; CREATE FUNCTION public.rebound_wrapper() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN public.rebound_mutator(); END $$; DROP FUNCTION public.rebound_mutator(); CREATE FUNCTION public.rebound_mutator() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.rebound_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN 1; END $body$; SELECT public.rebound_wrapper();"],
    ["invoked internal-language routine body", "CREATE FUNCTION public.opaque_abs(integer) RETURNS integer LANGUAGE internal IMMUTABLE STRICT AS 'int4abs'; SELECT public.opaque_abs(1);"],
    ["static catalog DDL in a PL/pgSQL body", "CREATE FUNCTION public.static_mutator() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN CREATE TABLE pg_catalog.static_probe(value integer); RETURN 1; END $$; SELECT public.static_mutator();"],
    ["supported-type parameter before opaque LANGUAGE option", "CREATE DOMAIN public.plpgsql AS integer; SET search_path=public,pg_catalog; CREATE FUNCTION public.header_decoy(language plpgsql DEFAULT 1) RETURNS integer AS 'int4abs' LANGUAGE internal IMMUTABLE STRICT; SELECT public.header_decoy(1);"],
    ["static INSERT in a PL/pgSQL body", "CREATE TABLE public.probe_sink(value integer); CREATE FUNCTION public.static_insert() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.probe_sink(value) VALUES (1); RETURN 1; END $$; SELECT public.static_insert();"],
    ["static UPDATE in a PL/pgSQL body", "CREATE TABLE public.probe_sink(value integer); CREATE FUNCTION public.static_update() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN UPDATE public.probe_sink SET value = 2; RETURN 1; END $$; SELECT public.static_update();"],
    ["static DELETE in a PL/pgSQL body", "CREATE TABLE public.probe_sink(value integer); CREATE FUNCTION public.static_delete() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN DELETE FROM public.probe_sink; RETURN 1; END $$; SELECT public.static_delete();"],
    ["static MERGE in a PL/pgSQL body", "CREATE TABLE public.probe_sink(value integer); CREATE FUNCTION public.static_merge() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN MERGE INTO public.probe_sink AS target USING (VALUES (1)) AS source(value) ON target.value = source.value WHEN MATCHED THEN UPDATE SET value = source.value WHEN NOT MATCHED THEN INSERT (value) VALUES (source.value); RETURN 1; END $$; SELECT public.static_merge();"],
    ["default-argument AS decoy before a static-write body", "CREATE TABLE public.probe_sink(value integer); CREATE FUNCTION public.default_body_decoy(note text DEFAULT 'AS ''SELECT 1''') RETURNS integer LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.probe_sink(value) VALUES (1); RETURN 1; END $$; SELECT public.default_body_decoy();"],
    ["static INSERT trigger fired by INSERT", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.insert_trigger_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER insert_effect AFTER INSERT ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.insert_trigger_effect(); INSERT INTO public.trigger_target(value) VALUES (1);"],
    ["static UPDATE constraint trigger fired by UPDATE", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); INSERT INTO public.trigger_target(value) VALUES (1); CREATE FUNCTION public.update_trigger_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE public.trigger_audit SET value = NEW.value; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER update_effect AFTER UPDATE ON public.trigger_target DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION public.update_trigger_effect(); UPDATE public.trigger_target SET value = 2;"],
    ["static DELETE trigger fired by DELETE", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); INSERT INTO public.trigger_target(value) VALUES (1); CREATE FUNCTION public.delete_trigger_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM public.trigger_audit; RETURN OLD; END $$; CREATE TRIGGER delete_effect AFTER DELETE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.delete_trigger_effect(); DELETE FROM public.trigger_target;"],
    ["recreated static trigger fired by INSERT", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.recreated_trigger_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER recreated_effect AFTER INSERT ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.recreated_trigger_effect(); DROP TRIGGER recreated_effect ON public.trigger_target; CREATE TRIGGER recreated_effect AFTER INSERT ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.recreated_trigger_effect(); INSERT INTO public.trigger_target(value) VALUES (1);"],
    ["static TRUNCATE trigger fired by TRUNCATE", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.truncate_trigger_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (1); RETURN NULL; END $$; CREATE TRIGGER truncate_effect AFTER TRUNCATE ON public.trigger_target FOR EACH STATEMENT EXECUTE FUNCTION public.truncate_trigger_effect(); TRUNCATE TABLE public.trigger_target;"],
    ["static INSERT trigger fired by MERGE", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.merge_insert_trigger_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER merge_insert_effect AFTER INSERT ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.merge_insert_trigger_effect(); MERGE INTO public.trigger_target AS target USING (VALUES (1)) AS source(value) ON false WHEN NOT MATCHED THEN INSERT (value) VALUES (source.value);"],
    ["static UPDATE trigger fired by MERGE", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); INSERT INTO public.trigger_target(value) VALUES (1); CREATE FUNCTION public.merge_update_trigger_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER merge_update_effect AFTER UPDATE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.merge_update_trigger_effect(); MERGE INTO public.trigger_target AS target USING (VALUES (1)) AS source(value) ON target.value = source.value WHEN MATCHED THEN UPDATE SET value = target.value + 1;"],
    ["static DELETE trigger fired by conditional MERGE", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); INSERT INTO public.trigger_target(value) VALUES (1); CREATE FUNCTION public.merge_delete_trigger_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (OLD.value); RETURN OLD; END $$; CREATE TRIGGER merge_delete_effect AFTER DELETE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.merge_delete_trigger_effect(); MERGE INTO public.trigger_target AS target USING (VALUES (1, true)) AS source(value, remove) ON target.value = source.value WHEN MATCHED AND source.remove THEN DELETE WHEN MATCHED THEN UPDATE SET value = source.value WHEN NOT MATCHED THEN INSERT (value) VALUES (source.value);"],
    ["search-path trigger target fired by qualified mutation", "CREATE SCHEMA private; CREATE TABLE private.trigger_audit(value integer); CREATE TABLE private.trigger_target(value integer); CREATE FUNCTION public.path_target_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO private.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; SET search_path=private,public; CREATE TRIGGER path_target AFTER INSERT ON trigger_target FOR EACH ROW EXECUTE FUNCTION public.path_target_effect(); INSERT INTO private.trigger_target(value) VALUES (1);"],
    ["qualified trigger target fired by search-path mutation", "CREATE SCHEMA private; CREATE TABLE private.trigger_audit(value integer); CREATE TABLE private.trigger_target(value integer); CREATE FUNCTION public.path_mutation_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO private.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; SET search_path=private,public; CREATE TRIGGER path_mutation AFTER INSERT ON private.trigger_target FOR EACH ROW EXECUTE FUNCTION public.path_mutation_effect(); INSERT INTO trigger_target(value) VALUES (1);"],
    ["second TRUNCATE target fires its trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.first_target(value integer); CREATE TABLE public.second_target(value integer); CREATE FUNCTION public.second_truncate_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (1); RETURN NULL; END $$; CREATE TRIGGER second_truncate AFTER TRUNCATE ON public.second_target FOR EACH STATEMENT EXECUTE FUNCTION public.second_truncate_effect(); TRUNCATE TABLE public.first_target, public.second_target;"],
    ["ON CONFLICT UPDATE fires UPDATE trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(id integer PRIMARY KEY, value integer); INSERT INTO public.trigger_target(id, value) VALUES (1, 1); CREATE FUNCTION public.upsert_update_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER upsert_update AFTER UPDATE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.upsert_update_effect(); INSERT INTO public.trigger_target(id, value) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value;"],
    ["CTE-prefixed INSERT fires INSERT trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.cte_insert_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER cte_insert AFTER INSERT ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.cte_insert_effect(); WITH RECURSIVE source(value) AS (VALUES (1)) INSERT INTO public.trigger_target AS target(value) SELECT value FROM source;"],
    ["CTE-prefixed UPDATE fires UPDATE trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); INSERT INTO public.trigger_target(value) VALUES (1); CREATE FUNCTION public.cte_update_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER cte_update AFTER UPDATE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.cte_update_effect(); WITH source(value) AS (VALUES (2)) UPDATE public.trigger_target AS target SET value = source.value FROM source;"],
    ["CTE-prefixed DELETE fires DELETE trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); INSERT INTO public.trigger_target(value) VALUES (1); CREATE FUNCTION public.cte_delete_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (OLD.value); RETURN OLD; END $$; CREATE TRIGGER cte_delete AFTER DELETE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.cte_delete_effect(); WITH source(value) AS (VALUES (1)) DELETE FROM public.trigger_target AS target USING source WHERE target.value = source.value;"],
    ["CTE-prefixed MERGE fires possible UPDATE trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); INSERT INTO public.trigger_target(value) VALUES (1); CREATE FUNCTION public.cte_merge_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER cte_merge AFTER UPDATE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.cte_merge_effect(); WITH source(value) AS (VALUES (1)) MERGE INTO public.trigger_target AS target USING source ON target.value = source.value WHEN MATCHED THEN UPDATE SET value = source.value;"],
    ["quoted ON column trigger fires on UPDATE", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.audit_target(\"x ON y\" integer); INSERT INTO public.audit_target(\"x ON y\") VALUES (1); CREATE FUNCTION public.quoted_on_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.\"x ON y\"); RETURN NEW; END $$; CREATE TRIGGER quoted_on AFTER UPDATE OF \"x ON y\" ON public.audit_target FOR EACH ROW EXECUTE FUNCTION public.quoted_on_effect(); UPDATE public.audit_target SET \"x ON y\" = 2;"],
    ["INSERT CTE member fires INSERT trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.member_insert_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER member_insert AFTER INSERT ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.member_insert_effect(); WITH changed AS (INSERT INTO public.trigger_target(value) VALUES (1) RETURNING value) SELECT * FROM changed;"],
    ["UPDATE CTE member fires UPDATE trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); INSERT INTO public.trigger_target(value) VALUES (1); CREATE FUNCTION public.member_update_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER member_update AFTER UPDATE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.member_update_effect(); WITH changed AS (UPDATE public.trigger_target SET value = 2 RETURNING value) SELECT * FROM changed;"],
    ["DELETE CTE member fires DELETE trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); INSERT INTO public.trigger_target(value) VALUES (1); CREATE FUNCTION public.member_delete_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (OLD.value); RETURN OLD; END $$; CREATE TRIGGER member_delete AFTER DELETE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.member_delete_effect(); WITH changed AS (DELETE FROM public.trigger_target RETURNING value) SELECT * FROM changed;"],
    ["second data-modifying CTE member fires trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.first_target(value integer); CREATE TABLE public.second_target(value integer); INSERT INTO public.second_target(value) VALUES (1); CREATE FUNCTION public.second_member_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (OLD.value); RETURN OLD; END $$; CREATE TRIGGER second_member AFTER DELETE ON public.second_target FOR EACH ROW EXECUTE FUNCTION public.second_member_effect(); WITH first AS (INSERT INTO public.first_target(value) VALUES (1) RETURNING value), second AS (DELETE FROM public.second_target RETURNING value) SELECT * FROM first UNION ALL SELECT * FROM second;"],
    ["MERGE CTE member fires UPDATE trigger", "CREATE TABLE public.trigger_target(value integer); INSERT INTO public.trigger_target(value) VALUES (1); CREATE FUNCTION public.merge_member_update_effect() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.merge_member_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN NEW; END $body$; CREATE TRIGGER merge_member_update AFTER UPDATE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.merge_member_update_effect(); WITH m AS (MERGE INTO public.trigger_target t USING (VALUES (1)) s(value) ON t.value=s.value WHEN MATCHED THEN UPDATE SET value=s.value RETURNING t.value) SELECT * FROM m;"],
    ["MERGE CTE member fires INSERT trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.merge_member_insert_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER merge_member_insert AFTER INSERT ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.merge_member_insert_effect(); WITH m AS (MERGE INTO public.trigger_target t USING (VALUES (1)) s(value) ON false WHEN NOT MATCHED THEN INSERT (value) VALUES (s.value) RETURNING t.value) SELECT * FROM m;"],
    ["MERGE CTE member fires DELETE trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); INSERT INTO public.trigger_target(value) VALUES (1); CREATE FUNCTION public.merge_member_delete_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (OLD.value); RETURN OLD; END $$; CREATE TRIGGER merge_member_delete AFTER DELETE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.merge_member_delete_effect(); WITH m AS (MERGE INTO public.trigger_target t USING (VALUES (1)) s(value) ON t.value=s.value WHEN MATCHED THEN DELETE RETURNING t.value) SELECT * FROM m;"],
    ["conditional MERGE CTE member unions possible trigger events", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); INSERT INTO public.trigger_target(value) VALUES (1); CREATE FUNCTION public.merge_member_union_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (OLD.value); RETURN OLD; END $$; CREATE TRIGGER merge_member_union AFTER DELETE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.merge_member_union_effect(); WITH m AS (MERGE INTO public.trigger_target t USING (VALUES (1, true)) s(value, remove) ON t.value=s.value WHEN MATCHED AND s.remove THEN DELETE WHEN MATCHED THEN UPDATE SET value=s.value WHEN NOT MATCHED THEN INSERT (value) VALUES (s.value) RETURNING t.value) SELECT * FROM m;"],
    ["nested WITH INSERT member fires INSERT trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.nested_insert_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER nested_insert AFTER INSERT ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.nested_insert_effect(); WITH wrapped AS (WITH source(value) AS (VALUES (1)) INSERT INTO public.trigger_target(value) SELECT value FROM source RETURNING value) SELECT * FROM wrapped;"],
    ["nested recursive WITH UPDATE member fires UPDATE trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); INSERT INTO public.trigger_target(value) VALUES (1); CREATE FUNCTION public.nested_update_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER nested_update AFTER UPDATE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.nested_update_effect(); WITH wrapped AS (WITH RECURSIVE source(value) AS (VALUES (2)) UPDATE public.trigger_target AS target SET value = source.value FROM source RETURNING target.value) SELECT * FROM wrapped;"],
    ["nested WITH derives inner DELETE and outer INSERT", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); CREATE TABLE public.unrelated_target(value integer); INSERT INTO public.trigger_target(value) VALUES (1); CREATE FUNCTION public.nested_delete_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (OLD.value); RETURN OLD; END $$; CREATE TRIGGER nested_delete AFTER DELETE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.nested_delete_effect(); WITH wrapped AS (WITH removed AS (DELETE FROM public.trigger_target RETURNING value) INSERT INTO public.unrelated_target(value) SELECT value FROM removed RETURNING value) SELECT * FROM wrapped;"],
    ["nested WITH MERGE member unions possible actions", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); INSERT INTO public.trigger_target(value) VALUES (1); CREATE FUNCTION public.nested_merge_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (OLD.value); RETURN OLD; END $$; CREATE TRIGGER nested_merge AFTER DELETE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.nested_merge_effect(); WITH wrapped AS (WITH source(value, remove) AS (VALUES (1, true)) MERGE INTO public.trigger_target t USING source s ON t.value = s.value WHEN MATCHED AND s.remove THEN DELETE WHEN MATCHED THEN UPDATE SET value = s.value WHEN NOT MATCHED THEN INSERT (value) VALUES (s.value) RETURNING t.value) SELECT * FROM wrapped;"],
    ["INSERT CTE member ON CONFLICT fires UPDATE trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(id integer PRIMARY KEY, value integer); INSERT INTO public.trigger_target(id, value) VALUES (1, 1); CREATE FUNCTION public.member_conflict_update_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER member_conflict_update AFTER UPDATE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.member_conflict_update_effect(); WITH changed AS (INSERT INTO public.trigger_target(id, value) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value RETURNING value) SELECT * FROM changed;"],
    ["INSERT CTE member DO NOTHING still fires INSERT trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(id integer PRIMARY KEY, value integer); CREATE FUNCTION public.member_nothing_insert_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER member_nothing_insert AFTER INSERT ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.member_nothing_insert_effect(); WITH changed AS (INSERT INTO public.trigger_target(id, value) VALUES (1, 1) ON CONFLICT (id) DO NOTHING RETURNING value) SELECT * FROM changed;"],
    ["search-path ALTER TABLE rename moves private trigger", "CREATE SCHEMA private; CREATE TABLE private.trigger_audit(value integer); CREATE TABLE private.trigger_target(value integer); CREATE FUNCTION public.path_table_rename_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO private.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; SET search_path=private,public; CREATE TRIGGER path_table_rename AFTER INSERT ON trigger_target FOR EACH ROW EXECUTE FUNCTION public.path_table_rename_effect(); ALTER TABLE trigger_target RENAME TO renamed_target; INSERT INTO private.renamed_target(value) VALUES (1);"],
    ["wrong-schema DROP TABLE preserves private trigger", "CREATE SCHEMA private; CREATE TABLE private.trigger_audit(value integer); CREATE TABLE private.trigger_target(value integer); CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.wrong_table_drop_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO private.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER wrong_table_drop AFTER INSERT ON private.trigger_target FOR EACH ROW EXECUTE FUNCTION public.wrong_table_drop_effect(); DROP TABLE public.trigger_target; INSERT INTO private.trigger_target(value) VALUES (1);"],
    ["unrelated DROP TABLE preserves trigger", "CREATE SCHEMA private; CREATE TABLE private.trigger_audit(value integer); CREATE TABLE private.trigger_target(value integer); CREATE TABLE private.unrelated_target(value integer); CREATE FUNCTION public.unrelated_table_drop_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO private.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER unrelated_table_drop AFTER INSERT ON private.trigger_target FOR EACH ROW EXECUTE FUNCTION public.unrelated_table_drop_effect(); SET search_path=private,public; DROP TABLE unrelated_target; INSERT INTO private.trigger_target(value) VALUES (1);"],
    ["trigger binds dynamic zero-argument overload", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.overloaded_trigger_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE FUNCTION public.overloaded_trigger_effect(value integer) RETURNS integer LANGUAGE sql AS $$ SELECT value $$; CREATE TRIGGER overloaded_dynamic AFTER INSERT ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.overloaded_trigger_effect(); INSERT INTO public.trigger_target(value) VALUES (1);"],
    ["unresolved trigger routine fails closed", "CREATE TABLE public.trigger_target(value integer); CREATE TRIGGER unresolved_effect AFTER INSERT ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.missing_trigger_effect(); INSERT INTO public.trigger_target(value) VALUES (1);"],
    ["search-path-created relation fires private trigger", "CREATE SCHEMA private; SET search_path=private,public; CREATE TABLE trigger_audit(value integer); CREATE TABLE trigger_target(value integer); CREATE FUNCTION public.created_path_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO private.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER created_path AFTER INSERT ON trigger_target FOR EACH ROW EXECUTE FUNCTION public.created_path_effect(); INSERT INTO private.trigger_target(value) VALUES (1);"],
    ["current-role-created relation fires trigger", "CREATE ROLE private_creator; CREATE SCHEMA private_creator; SET ROLE private_creator; SET search_path=\"$user\",public; CREATE TABLE trigger_audit(value integer); CREATE TABLE trigger_target(value integer); CREATE FUNCTION public.role_created_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO private_creator.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER role_created AFTER INSERT ON trigger_target FOR EACH ROW EXECUTE FUNCTION public.role_created_effect(); INSERT INTO private_creator.trigger_target(value) VALUES (1);"],
    ["renamed private trigger survives old-name cleanup", "CREATE SCHEMA private; CREATE TABLE private.trigger_audit(value integer); CREATE TABLE private.trigger_target(value integer); CREATE FUNCTION public.renamed_private_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO private.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER private_old AFTER INSERT ON private.trigger_target FOR EACH ROW EXECUTE FUNCTION public.renamed_private_effect(); SET search_path=private,public; ALTER TRIGGER private_old ON trigger_target RENAME TO private_new; DROP TRIGGER IF EXISTS private_old ON private.trigger_target; INSERT INTO private.trigger_target(value) VALUES (1);"],
    ["wrong-schema trigger cleanup preserves private trigger", "CREATE SCHEMA private; CREATE TABLE private.trigger_audit(value integer); CREATE TABLE private.trigger_target(value integer); CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.wrong_schema_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO private.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER wrong_schema AFTER INSERT ON private.trigger_target FOR EACH ROW EXECUTE FUNCTION public.wrong_schema_effect(); DROP TRIGGER IF EXISTS wrong_schema ON public.trigger_target; INSERT INTO private.trigger_target(value) VALUES (1);"],
    ["wrong-signature private shadow before catalog ALTER", "CREATE SCHEMA private; SET search_path=private,pg_catalog; CREATE FUNCTION private.uuid_eq(integer, integer) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$; ALTER FUNCTION uuid_eq(uuid, uuid) VOLATILE;"],
    ["wrong-signature private shadow before catalog DROP", "CREATE SCHEMA private; SET search_path=private,pg_catalog; CREATE FUNCTION private.uuid_eq(integer, integer) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$; DROP FUNCTION uuid_eq(uuid, uuid);"],
    ["dynamic catalog DDL through SELECT FROM", "CREATE FUNCTION public.catalog_mutator() RETURNS SETOF integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN NEXT 1; END $body$; SELECT * FROM public.catalog_mutator();"],
    ["dynamic catalog DDL through SELECT predicate", "CREATE FUNCTION public.catalog_mutator() RETURNS boolean LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN true; END $body$; SELECT 1 WHERE public.catalog_mutator();"],
    ["dynamic catalog DDL through quoted routine call", "CREATE FUNCTION public.catalog_mutator() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$; SELECT public.\"catalog_mutator\"();"],
    ["dynamic catalog DDL through INSERT SELECT", "CREATE FUNCTION public.catalog_mutator() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN 1; END $body$; CREATE TABLE public.probe_sink(value integer); INSERT INTO public.probe_sink SELECT public.catalog_mutator();"],
    ["dynamic catalog DDL through UPDATE", "CREATE FUNCTION public.catalog_mutator() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN 1; END $body$; CREATE TABLE public.probe_sink(value integer); UPDATE public.probe_sink SET value = public.catalog_mutator();"],
    ["dynamic catalog DDL through CREATE TABLE AS", "CREATE FUNCTION public.catalog_mutator() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN 1; END $body$; CREATE TABLE public.probe_sink AS SELECT public.catalog_mutator() AS value;"],
    ["dynamic catalog DDL through transitive wrapper", "CREATE FUNCTION public.catalog_mutator() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN 1; END $body$; CREATE FUNCTION public.catalog_wrapper() RETURNS integer LANGUAGE sql AS $$ SELECT public.catalog_mutator() $$; SELECT public.catalog_wrapper();"],
    ["Unicode-delimited reviewed relation", "ALTER TABLE U&\"publ\\0069c\".bookings DISABLE ROW LEVEL SECURITY;"],
    ["Unicode-delimited reviewed role", "ALTER USER U&\"authent\\0069cated\" SET search_path = private, pg_catalog, public;"],
    ["Unicode-delimited catalog operator", "DROP OPERATOR U&\"pg\\005fcatalog\".= (uuid, uuid) CASCADE;"],
    ["Unicode-delimited reviewed index", "DROP INDEX U&\"publ\\0069c\".bookings_pkey CASCADE;"],
    ["dynamic function after rename", "CREATE FUNCTION public.catalog_mutator() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$; ALTER FUNCTION public.catalog_mutator() RENAME TO renamed_catalog_mutator; SELECT public.renamed_catalog_mutator();"],
    ["dynamic procedure after schema move", "CREATE SCHEMA private; CREATE PROCEDURE public.catalog_mutator() LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$; ALTER PROCEDURE public.catalog_mutator() SET SCHEMA private; CALL private.catalog_mutator();"],
    ["reviewed schema rename", "ALTER SCHEMA public RENAME TO app_public;"],
    ["unknown ownership cascade", "DROP OWNED BY authenticated CASCADE;"],
    ["unknown ownership reassignment", "REASSIGN OWNED BY postgres TO authenticated;"],
    ["reviewed operator family", "ALTER OPERATOR FAMILY pg_catalog.uuid_ops USING btree ADD OPERATOR 1 pg_catalog.= (uuid, uuid);"],
    ["reviewed access method", "ALTER ACCESS METHOD btree RENAME TO unsafe_btree;"],
  ])("rejects reviewed provenance after %s catalog mutation", (_shape, sql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      { file: "zzzz_catalog.sql", sql },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(false);
  });

  it.each([
    [
      "operator class",
      "CREATE OPERATOR CLASS public.uuid_ops DEFAULT FOR TYPE uuid USING btree AS " +
        "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
        "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
        "CREATE INDEX bookings_uuid_ops_probe ON public.bookings USING btree (id public.uuid_ops);",
    ],
    [
      "comment-separated operator class",
      "CREATE/*probe*/ OPERATOR CLASS public.evil_uuid_ops FOR TYPE uuid USING btree AS " +
        "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
        "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
        "CREATE INDEX bookings_uuid_ops_probe ON public.bookings USING btree (id public.evil_uuid_ops);",
    ],
    [
      "access method",
      "CREATE ACCESS METHOD evil TYPE INDEX HANDLER pg_catalog.bthandler; " +
        "CREATE INDEX bookings_evil_probe ON public.bookings USING evil (id);",
    ],
  ])("rejects a reviewed index backed by a created %s", (_shape, sql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      { file: "zzzz_index_catalog.sql", sql },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(false);
  });

  it.each([
    [
      "creation-time search_path",
      "CREATE SCHEMA private; " +
        "CREATE OPERATOR CLASS private.evil_uuid_ops FOR TYPE uuid USING btree AS " +
        "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
        "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
        "SET search_path = private, public; " +
        "CREATE INDEX bookings_private_ops_probe ON public.bookings USING btree (id evil_uuid_ops); " +
        "RESET search_path;",
    ],
    ...["SET", "SET LOCAL"].map((command) => [
      `${command} no-space assignment`,
      "CREATE SCHEMA private; " +
        "CREATE OPERATOR CLASS private.evil_uuid_ops FOR TYPE uuid USING btree AS " +
        "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
        "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
        `${command} search_path=private,public; ` +
        "CREATE INDEX bookings_private_ops_probe ON public.bookings USING btree (id evil_uuid_ops);",
    ]),
    [
      "comment-separated SET",
      "CREATE SCHEMA private; " +
        "CREATE OPERATOR CLASS private.evil_uuid_ops FOR TYPE uuid USING btree AS " +
        "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
        "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
        "SET/*probe*/ search_path=private,public; " +
        "CREATE INDEX bookings_private_ops_probe ON public.bookings USING btree (id evil_uuid_ops);",
    ],
    [
      "SET SCHEMA alias",
      "CREATE SCHEMA private; " +
        "CREATE OPERATOR CLASS private.evil_uuid_ops FOR TYPE uuid USING btree AS " +
        "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
        "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
        "SET SCHEMA 'private'; " +
        "CREATE INDEX bookings_private_ops_probe ON public.bookings USING btree (id evil_uuid_ops);",
    ],
    [
      "explicit pg_catalog after private",
      "CREATE SCHEMA private; " +
        "CREATE OPERATOR CLASS private.uuid_ops FOR TYPE uuid USING btree AS " +
        "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
        "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
        "SET search_path = private, pg_catalog, public; " +
        "CREATE INDEX bookings_private_ops_probe ON public.bookings USING btree (id uuid_ops);",
    ],
    [
      "qualified operator class",
      "CREATE SCHEMA private; " +
        "CREATE OPERATOR CLASS private.uuid_ops FOR TYPE uuid USING btree AS " +
        "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
        "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
        "CREATE INDEX bookings_private_ops_probe ON public.bookings USING btree (id private.uuid_ops);",
    ],
  ])("rejects a reviewed index bound to a private opclass through %s", (_shape, sql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      { file: "zzzz_private_opclass.sql", sql },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(false);
  });

  it.each([
    ["implicit pg_catalog", ""],
    ["explicit pg_catalog placement", "SET search_path = public, pg_catalog; "],
    ["unknown explicit path", "SET search_path = missing_schema; "],
  ])("rejects a reviewed index bound through %s opclass lookup", (_shape, setPath) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      {
        file: "zzzz_pg_catalog_opclass.sql",
        sql: "CREATE OPERATOR CLASS pg_catalog.evil_uuid_ops FOR TYPE uuid USING btree AS " +
          "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
          "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
          setPath +
          "CREATE INDEX bookings_pg_catalog_ops_probe ON public.bookings USING btree (id evil_uuid_ops);",
      },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(false);
  });

  it.each([
    ["relevant operator cleanup", "CREATE OPERATOR public.= (LEFTARG = uuid, RIGHTARG = uuid, FUNCTION = pg_catalog.uuid_eq); DROP OPERATOR public.= (uuid, uuid);"],
    ["operator cleanup", "CREATE OPERATOR public.## (LEFTARG = uuid, RIGHTARG = uuid, FUNCTION = pg_catalog.uuid_eq); DROP OPERATOR public.## (uuid, uuid);"],
    ["cast cleanup", "CREATE TYPE public.effect_source AS ENUM ('x'); CREATE CAST (public.effect_source AS text) WITH INOUT AS IMPLICIT; DROP CAST (public.effect_source AS text);"],
    ["unrelated types and cast", "CREATE TYPE public.effect_source AS ENUM ('x'); CREATE TYPE public.effect_target AS ENUM ('y'); CREATE CAST (public.effect_source AS public.effect_target) WITH INOUT;"],
    ["unrelated-schema operator", "CREATE SCHEMA private; CREATE OPERATOR private.= (LEFTARG = uuid, RIGHTARG = uuid, FUNCTION = pg_catalog.uuid_eq);"],
    ["unrelated-schema type shadow", "CREATE SCHEMA private; CREATE DOMAIN private.uuid AS text;"],
    ["unrelated schema", "CREATE SCHEMA private; ALTER SCHEMA private OWNER TO postgres;"],
    ["unrelated operator family", "CREATE OPERATOR FAMILY public.unrelated_ops USING hash; ALTER OPERATOR FAMILY public.unrelated_ops USING hash OWNER TO postgres;"],
    ["unrelated-schema operator family", "CREATE SCHEMA private; CREATE OPERATOR FAMILY private.uuid_ops USING btree; ALTER OPERATOR FAMILY private.uuid_ops USING btree OWNER TO postgres;"],
    ["unrelated table ALTER", "CREATE TABLE public.unrelated_rows (id uuid); ALTER TABLE public.unrelated_rows ALTER COLUMN id TYPE text USING id::text;"],
    [
      "unused operator class",
      "CREATE OPERATOR CLASS public.uuid_ops DEFAULT FOR TYPE uuid USING btree AS " +
        "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
        "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid);",
    ],
    ["unused access method", "CREATE ACCESS METHOD evil TYPE INDEX HANDLER pg_catalog.bthandler;"],
    [
      "unused private operator class",
      "CREATE SCHEMA private; " +
        "CREATE OPERATOR CLASS private.uuid_ops FOR TYPE uuid USING btree AS " +
        "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
        "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid);",
    ],
    [
      "unused pg_catalog operator class",
      "CREATE OPERATOR CLASS pg_catalog.evil_uuid_ops FOR TYPE uuid USING btree AS " +
        "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
        "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid);",
    ],
    [
      "implicit pg_catalog built-in before private shadow",
      "CREATE SCHEMA private; " +
        "CREATE OPERATOR CLASS private.uuid_ops FOR TYPE uuid USING btree AS " +
        "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
        "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
        "SET search_path = private, public; " +
        "CREATE INDEX bookings_builtin_shadow_probe ON public.bookings USING btree (id uuid_ops);",
    ],
    [
      "SET SCHEMA retains implicit pg_catalog built-in precedence",
      "CREATE SCHEMA private; " +
        "CREATE OPERATOR CLASS private.uuid_ops FOR TYPE uuid USING btree AS " +
        "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
        "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
        "SET SCHEMA 'private'; " +
        "CREATE INDEX bookings_builtin_shadow_probe ON public.bookings USING btree (id uuid_ops);",
    ],
    [
      "ordinary built-in pg_catalog operator class",
      "CREATE INDEX bookings_builtin_ops_probe ON public.bookings USING btree (id pg_catalog.uuid_ops);",
    ],
    [
      "operator class on unrelated index",
      "CREATE TABLE public.catalog_control_rows (id uuid); " +
        "CREATE OPERATOR CLASS public.uuid_ops DEFAULT FOR TYPE uuid USING btree AS " +
        "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
        "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
        "CREATE INDEX catalog_control_uuid_idx ON public.catalog_control_rows USING btree (id public.uuid_ops);",
    ],
    [
      "access method on unrelated index",
      "CREATE TABLE public.catalog_control_rows (id uuid); " +
        "CREATE ACCESS METHOD evil TYPE INDEX HANDLER pg_catalog.bthandler; " +
        "CREATE INDEX catalog_control_evil_idx ON public.catalog_control_rows USING evil (id);",
    ],
    [
      "private operator class on unrelated index",
      "CREATE SCHEMA private; CREATE TABLE public.catalog_control_rows (id uuid); " +
        "CREATE OPERATOR CLASS private.uuid_ops FOR TYPE uuid USING btree AS " +
        "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
        "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
        "SET search_path = private, public; " +
        "CREATE INDEX catalog_control_uuid_idx ON public.catalog_control_rows USING btree (id uuid_ops); " +
        "RESET search_path;",
    ],
    [
      "pg_catalog operator class on unrelated index",
      "CREATE TABLE public.catalog_control_rows (id uuid); " +
        "CREATE OPERATOR CLASS pg_catalog.evil_uuid_ops FOR TYPE uuid USING btree AS " +
        "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
        "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
        "CREATE INDEX catalog_control_uuid_idx ON public.catalog_control_rows USING btree (id evil_uuid_ops);",
    ],
    [
      "reviewed operator-class index cleanup",
      "CREATE OPERATOR CLASS public.uuid_ops DEFAULT FOR TYPE uuid USING btree AS " +
        "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
        "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
        "CREATE INDEX bookings_uuid_ops_probe ON public.bookings USING btree (id public.uuid_ops); " +
        "DROP INDEX public.bookings_uuid_ops_probe; DROP OPERATOR CLASS public.uuid_ops USING btree;",
    ],
    [
      "reviewed access-method index cleanup",
      "CREATE ACCESS METHOD evil TYPE INDEX HANDLER pg_catalog.bthandler; " +
        "CREATE INDEX bookings_evil_probe ON public.bookings USING evil (id); " +
        "DROP INDEX public.bookings_evil_probe; DROP ACCESS METHOD evil;",
    ],
    [
      "private opclass reviewed-index cleanup",
      "CREATE SCHEMA private; " +
        "CREATE OPERATOR CLASS private.evil_uuid_ops FOR TYPE uuid USING btree AS " +
        "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
        "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
        "SET search_path = private, public; " +
        "CREATE INDEX bookings_private_ops_probe ON public.bookings USING btree (id evil_uuid_ops); " +
        "RESET search_path; DROP INDEX public.bookings_private_ops_probe; " +
        "DROP OPERATOR CLASS private.evil_uuid_ops USING btree;",
    ],
    [
      "pg_catalog opclass reviewed-index cleanup",
      "CREATE OPERATOR CLASS pg_catalog.evil_uuid_ops FOR TYPE uuid USING btree AS " +
        "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
        "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
        "CREATE INDEX bookings_pg_catalog_ops_probe ON public.bookings USING btree (id evil_uuid_ops); " +
        "DROP INDEX public.bookings_pg_catalog_ops_probe; " +
        "DROP OPERATOR CLASS pg_catalog.evil_uuid_ops USING btree;",
    ],
  ])("accepts reviewed provenance after effective or unrelated %s", (_shape, sql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      { file: "zzzz_catalog_control.sql", sql },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(true);
  });

  it.each([
    ["ALTER", "CREATE SCHEMA private; SET search_path=private,pg_catalog; CREATE FUNCTION f() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$; ALTER FUNCTION f() VOLATILE;"],
    ["DROP", "CREATE SCHEMA private; SET search_path=private,pg_catalog; CREATE FUNCTION f() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$; DROP FUNCTION f();"],
    ["exact overload ALTER", "CREATE SCHEMA private; SET search_path=private,pg_catalog; CREATE FUNCTION f() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$; CREATE FUNCTION f(integer) RETURNS integer LANGUAGE sql AS $$ SELECT $1 $$; ALTER FUNCTION f() VOLATILE;"],
    ["exact overload DROP", "CREATE SCHEMA private; SET search_path=private,pg_catalog; CREATE FUNCTION f() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$; CREATE FUNCTION f(integer) RETURNS integer LANGUAGE sql AS $$ SELECT $1 $$; DROP FUNCTION f();"],
    ["uninvoked dynamic routine", "CREATE FUNCTION public.catalog_mutator() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$; SELECT COALESCE(1, 1);"],
    ["safe standard single-quoted body", "CREATE FUNCTION public.quoted_safe() RETURNS integer LANGUAGE plpgsql AS 'BEGIN RETURN 1; END'; SELECT public.quoted_safe();"],
    ["literal text in a standard single-quoted body", "CREATE FUNCTION public.quoted_literal() RETURNS text LANGUAGE plpgsql AS 'BEGIN RETURN ''EXECUTE public.fake()''; END'; SELECT public.quoted_literal();"],
    ["uninvoked unanalysable escape-string body", "CREATE FUNCTION public.escape_body() RETURNS integer LANGUAGE plpgsql AS E'BEGIN RETURN 1; END'; SELECT 1;"],
    ["safe callee recreation behind a wrapper", "CREATE FUNCTION public.rebound_mutator() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'SELECT 1'; RETURN 1; END $$; CREATE FUNCTION public.rebound_wrapper() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN public.rebound_mutator(); END $$; DROP FUNCTION public.rebound_mutator(); CREATE FUNCTION public.rebound_mutator() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$; SELECT public.rebound_wrapper();"],
    ["safe wrapper and callee recreation", "CREATE FUNCTION public.rebound_mutator() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$; CREATE FUNCTION public.rebound_wrapper() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN public.rebound_mutator(); END $$; DROP FUNCTION public.rebound_mutator(); CREATE FUNCTION public.rebound_mutator() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN 2; END $$; SELECT public.rebound_wrapper();"],
    ["uninvoked internal-language routine body", "CREATE FUNCTION public.opaque_abs(integer) RETURNS integer LANGUAGE internal IMMUTABLE STRICT AS 'int4abs'; SELECT 1;"],
    ["safe static PL/pgSQL body", "CREATE FUNCTION public.static_safe() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; RETURN 1; END $$; SELECT public.static_safe();"],
    ["safe static SQL body", "CREATE FUNCTION public.static_sql_safe() RETURNS integer LANGUAGE sql AS 'SELECT 1'; SELECT public.static_sql_safe();"],
    ["static DDL text literal in a PL/pgSQL body", "CREATE FUNCTION public.static_literal() RETURNS text LANGUAGE plpgsql AS $$ BEGIN RETURN 'CREATE TABLE pg_catalog.static_probe(value integer)'; END $$; SELECT public.static_literal();"],
    ["LANGUAGE text in a dollar-body comment", "CREATE FUNCTION public.language_comment() RETURNS integer AS $$ BEGIN /* LANGUAGE internal */ RETURN 1; END $$ LANGUAGE plpgsql; SELECT public.language_comment();"],
    ["LANGUAGE text in a single-quoted body comment", "CREATE FUNCTION public.quoted_language_comment() RETURNS integer AS 'BEGIN /* LANGUAGE internal */ RETURN 1; END' LANGUAGE plpgsql; SELECT public.quoted_language_comment();"],
    ["LANGUAGE text in a single-quoted body literal", "CREATE FUNCTION public.language_literal() RETURNS text AS 'BEGIN RETURN ''LANGUAGE internal''; END' LANGUAGE plpgsql; SELECT public.language_literal();"],
    ["opaque-type parameter before supported LANGUAGE option", "CREATE DOMAIN public.opaque_language AS integer; SET search_path=public,pg_catalog; CREATE FUNCTION public.header_safe(language opaque_language DEFAULT 1) RETURNS public.opaque_language AS 'SELECT $1' LANGUAGE sql; SELECT public.header_safe(1);"],
    ["static write text in PL/pgSQL comments and literals", "CREATE FUNCTION public.static_write_text() RETURNS text LANGUAGE plpgsql AS $$ BEGIN /* INSERT UPDATE */ RETURN 'DELETE MERGE'; END $$; SELECT public.static_write_text();"],
    ["uninvoked static INSERT body", "CREATE TABLE public.probe_sink(value integer); CREATE FUNCTION public.uninvoked_insert() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.probe_sink(value) VALUES (1); RETURN 1; END $$; SELECT 1;"],
    ["uninvoked static UPDATE body", "CREATE TABLE public.probe_sink(value integer); CREATE FUNCTION public.uninvoked_update() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN UPDATE public.probe_sink SET value = 2; RETURN 1; END $$; SELECT 1;"],
    ["uninvoked static DELETE body", "CREATE TABLE public.probe_sink(value integer); CREATE FUNCTION public.uninvoked_delete() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN DELETE FROM public.probe_sink; RETURN 1; END $$; SELECT 1;"],
    ["uninvoked static MERGE body", "CREATE TABLE public.probe_sink(value integer); CREATE FUNCTION public.uninvoked_merge() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN MERGE INTO public.probe_sink AS target USING (VALUES (1)) AS source(value) ON target.value = source.value WHEN MATCHED THEN UPDATE SET value = source.value WHEN NOT MATCHED THEN INSERT (value) VALUES (source.value); RETURN 1; END $$; SELECT 1;"],
    ["safe body after a default-argument AS decoy", "CREATE FUNCTION public.default_body_safe(note text DEFAULT 'AS ''SELECT 1''') RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$; SELECT public.default_body_safe();"],
    ["quoted static-write identifier in a safe body", "CREATE FUNCTION public.quoted_update_identifier() RETURNS text LANGUAGE plpgsql AS $$ DECLARE \"update\" text := 'safe'; BEGIN RETURN \"update\"; END $$; SELECT public.quoted_update_identifier();"],
    ["unfired static trigger definition", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.unfired_trigger_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER unfired_effect AFTER INSERT ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.unfired_trigger_effect(); SELECT 1;"],
    ["unrelated-table DML beside a static trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); CREATE TABLE public.unrelated_target(value integer); CREATE FUNCTION public.unrelated_trigger_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER unrelated_effect AFTER INSERT ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.unrelated_trigger_effect(); INSERT INTO public.unrelated_target(value) VALUES (1);"],
    ["renamed and dropped static trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.dropped_trigger_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER dropped_effect AFTER INSERT ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.dropped_trigger_effect(); ALTER TRIGGER dropped_effect ON public.trigger_target RENAME TO renamed_effect; DROP TRIGGER renamed_effect ON public.trigger_target; INSERT INTO public.trigger_target(value) VALUES (1);"],
    ["TRUNCATE without a matching trigger event", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.unmatched_truncate_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER unmatched_truncate AFTER UPDATE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.unmatched_truncate_effect(); TRUNCATE TABLE public.trigger_target;"],
    ["unrelated-table TRUNCATE beside a static trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); CREATE TABLE public.unrelated_target(value integer); CREATE FUNCTION public.unrelated_truncate_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (1); RETURN NULL; END $$; CREATE TRIGGER unrelated_truncate AFTER TRUNCATE ON public.trigger_target FOR EACH STATEMENT EXECUTE FUNCTION public.unrelated_truncate_effect(); TRUNCATE TABLE public.unrelated_target;"],
    ["MERGE without a matching trigger action", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); INSERT INTO public.trigger_target(value) VALUES (1); CREATE FUNCTION public.unmatched_merge_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (OLD.value); RETURN OLD; END $$; CREATE TRIGGER unmatched_merge AFTER DELETE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.unmatched_merge_effect(); MERGE INTO public.trigger_target AS target USING (VALUES (1)) AS source(value) ON target.value = source.value WHEN MATCHED THEN UPDATE SET value = target.value + 1;"],
    ["UPDATE OF delete-named column does not fire on DELETE", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(\"delete\" integer); CREATE FUNCTION public.quoted_delete_column_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (1); RETURN NEW; END $$; CREATE TRIGGER quoted_delete_column AFTER UPDATE OF \"delete\" ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.quoted_delete_column_effect(); DELETE FROM public.trigger_target;"],
    ["UPDATE OF insert-named column does not fire on INSERT", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(\"insert\" integer); CREATE FUNCTION public.quoted_insert_column_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (1); RETURN NEW; END $$; CREATE TRIGGER quoted_insert_column AFTER UPDATE OF \"insert\" ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.quoted_insert_column_effect(); INSERT INTO public.trigger_target(\"insert\") VALUES (1);"],
    ["UPDATE OF truncate-named column does not fire on TRUNCATE", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(\"truncate\" integer); CREATE FUNCTION public.quoted_truncate_column_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (1); RETURN NEW; END $$; CREATE TRIGGER quoted_truncate_column AFTER UPDATE OF \"truncate\" ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.quoted_truncate_column_effect(); TRUNCATE TABLE public.trigger_target;"],
    ["search-path trigger ignores qualified public mutation", "CREATE SCHEMA private; CREATE TABLE private.trigger_audit(value integer); CREATE TABLE private.trigger_target(value integer); CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.private_path_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO private.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; SET search_path=private,public; CREATE TRIGGER private_path AFTER INSERT ON trigger_target FOR EACH ROW EXECUTE FUNCTION public.private_path_effect(); INSERT INTO public.trigger_target(value) VALUES (1);"],
    ["qualified public trigger ignores private search-path mutation", "CREATE SCHEMA private; CREATE TABLE public.trigger_audit(value integer); CREATE TABLE private.trigger_target(value integer); CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.public_path_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; SET search_path=private,public; CREATE TRIGGER public_path AFTER INSERT ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.public_path_effect(); INSERT INTO trigger_target(value) VALUES (1);"],
    ["multi-table TRUNCATE without matching trigger target", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); CREATE TABLE public.first_target(value integer); CREATE TABLE public.second_target(value integer); CREATE FUNCTION public.unmatched_multi_truncate_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (1); RETURN NULL; END $$; CREATE TRIGGER unmatched_multi_truncate AFTER TRUNCATE ON public.trigger_target FOR EACH STATEMENT EXECUTE FUNCTION public.unmatched_multi_truncate_effect(); TRUNCATE TABLE public.first_target, public.second_target;"],
    ["ON CONFLICT DO NOTHING does not fire UPDATE trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(id integer PRIMARY KEY, value integer); INSERT INTO public.trigger_target(id, value) VALUES (1, 1); CREATE FUNCTION public.upsert_nothing_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER upsert_nothing AFTER UPDATE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.upsert_nothing_effect(); INSERT INTO public.trigger_target(id, value) VALUES (1, 2) ON CONFLICT (id) DO NOTHING;"],
    ["CTE-internal mutation keywords do not fire trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.cte_inert_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER cte_inert AFTER UPDATE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.cte_inert_effect(); WITH source AS (SELECT 'UPDATE public.trigger_target; MERGE INTO public.trigger_target' AS text) SELECT * FROM source;"],
    ["quoted ON column trigger ignores DELETE", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.audit_target(\"x ON y\" integer); CREATE FUNCTION public.quoted_on_delete_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.\"x ON y\"); RETURN NEW; END $$; CREATE TRIGGER quoted_on_delete AFTER UPDATE OF \"x ON y\" ON public.audit_target FOR EACH ROW EXECUTE FUNCTION public.quoted_on_delete_effect(); DELETE FROM public.audit_target;"],
    ["read-only CTE member does not fire trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.read_member_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER read_member AFTER INSERT ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.read_member_effect(); WITH source AS (SELECT 1 AS value) SELECT * FROM source;"],
    ["unrelated data-modifying CTE member does not fire trigger", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); CREATE TABLE public.unrelated_target(value integer); CREATE FUNCTION public.unrelated_member_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER unrelated_member AFTER INSERT ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.unrelated_member_effect(); WITH changed AS (INSERT INTO public.unrelated_target(value) VALUES (1) RETURNING value) SELECT * FROM changed;"],
    ["MERGE CTE member DO NOTHING does not fire trigger", "CREATE TABLE public.trigger_target(value integer); INSERT INTO public.trigger_target(value) VALUES (1); CREATE FUNCTION public.merge_member_nothing_effect() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.merge_member_nothing_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN NEW; END $body$; CREATE TRIGGER merge_member_nothing AFTER UPDATE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.merge_member_nothing_effect(); WITH m AS (MERGE INTO public.trigger_target t USING (VALUES (1)) s(value) ON t.value=s.value WHEN MATCHED THEN DO NOTHING RETURNING t.value) SELECT * FROM m;"],
    ["MERGE CTE member without matching trigger action", "CREATE TABLE public.trigger_target(value integer); INSERT INTO public.trigger_target(value) VALUES (1); CREATE FUNCTION public.merge_member_unmatched_effect() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.merge_member_unmatched_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN OLD; END $body$; CREATE TRIGGER merge_member_unmatched AFTER DELETE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.merge_member_unmatched_effect(); WITH m AS (MERGE INTO public.trigger_target t USING (VALUES (1)) s(value) ON t.value=s.value WHEN MATCHED THEN UPDATE SET value=s.value RETURNING t.value) SELECT * FROM m;"],
    ["unrelated MERGE CTE member does not fire trigger", "CREATE TABLE public.trigger_target(value integer); CREATE TABLE public.unrelated_target(value integer); INSERT INTO public.unrelated_target(value) VALUES (1); CREATE FUNCTION public.unrelated_merge_member_effect() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.unrelated_merge_member_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN NEW; END $body$; CREATE TRIGGER unrelated_merge_member AFTER UPDATE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.unrelated_merge_member_effect(); WITH m AS (MERGE INTO public.unrelated_target t USING (VALUES (1)) s(value) ON t.value=s.value WHEN MATCHED THEN UPDATE SET value=s.value RETURNING t.value) SELECT * FROM m;"],
    ["nested read-only WITH terminates without trigger leakage", "CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.nested_read_effect() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.nested_read_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN NEW; END $body$; CREATE TRIGGER nested_read AFTER INSERT ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.nested_read_effect(); WITH outer_cte AS (WITH RECURSIVE middle AS (WITH inner_cte AS (SELECT 1 AS value) SELECT * FROM inner_cte) SELECT * FROM middle) SELECT * FROM outer_cte;"],
    ["nested unrelated WITH mutation does not fire trigger", "CREATE TABLE public.trigger_target(value integer); CREATE TABLE public.unrelated_target(value integer); CREATE FUNCTION public.nested_unrelated_effect() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.nested_unrelated_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN NEW; END $body$; CREATE TRIGGER nested_unrelated AFTER INSERT ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.nested_unrelated_effect(); WITH wrapped AS (WITH source(value) AS (VALUES (1)) INSERT INTO public.unrelated_target(value) SELECT value FROM source RETURNING value) SELECT * FROM wrapped;"],
    ["INSERT CTE member DO NOTHING does not fire UPDATE trigger", "CREATE TABLE public.trigger_target(id integer PRIMARY KEY, value integer); INSERT INTO public.trigger_target(id, value) VALUES (1, 1); CREATE FUNCTION public.member_nothing_update_effect() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.member_nothing_update_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN NEW; END $body$; CREATE TRIGGER member_nothing_update AFTER UPDATE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.member_nothing_update_effect(); WITH changed AS (INSERT INTO public.trigger_target(id, value) VALUES (1, 2) ON CONFLICT (id) DO NOTHING RETURNING value) SELECT * FROM changed;"],
    ["INSERT CTE member ON CONFLICT ignores DELETE trigger", "CREATE TABLE public.trigger_target(id integer PRIMARY KEY, value integer); INSERT INTO public.trigger_target(id, value) VALUES (1, 1); CREATE FUNCTION public.member_conflict_delete_effect() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.member_conflict_delete_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN OLD; END $body$; CREATE TRIGGER member_conflict_delete AFTER DELETE ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.member_conflict_delete_effect(); WITH changed AS (INSERT INTO public.trigger_target(id, value) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value RETURNING value) SELECT * FROM changed;"],
    ["search-path DROP TABLE and recreate clears private trigger", "CREATE SCHEMA private; CREATE TABLE private.trigger_target(value integer); CREATE FUNCTION public.path_table_drop_effect() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.path_table_drop_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN NEW; END $body$; SET search_path=private,public; CREATE TRIGGER path_table_drop AFTER INSERT ON trigger_target FOR EACH ROW EXECUTE FUNCTION public.path_table_drop_effect(); DROP TABLE trigger_target; CREATE TABLE trigger_target(value integer); INSERT INTO private.trigger_target(value) VALUES (1);"],
    ["current-role ALTER and DROP TABLE clear renamed trigger", "CREATE ROLE private_creator; CREATE SCHEMA private_creator; SET ROLE private_creator; SET search_path=\"$user\",public; CREATE TABLE trigger_target(value integer); CREATE FUNCTION public.role_table_lifecycle_effect() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.role_table_lifecycle_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN NEW; END $body$; CREATE TRIGGER role_table_lifecycle AFTER INSERT ON trigger_target FOR EACH ROW EXECUTE FUNCTION public.role_table_lifecycle_effect(); ALTER TABLE trigger_target RENAME TO renamed_target; DROP TABLE renamed_target; CREATE TABLE renamed_target(value integer); INSERT INTO private_creator.renamed_target(value) VALUES (1);"],
    ["trigger ignores dynamic argument overload", "CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.safe_overloaded_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE FUNCTION public.safe_overloaded_trigger(value integer) RETURNS integer LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_target(value) VALUES (value); RETURN value; END $$; CREATE TRIGGER safe_overloaded AFTER INSERT ON public.trigger_target FOR EACH ROW EXECUTE FUNCTION public.safe_overloaded_trigger(); INSERT INTO public.trigger_target(value) VALUES (1);"],
    ["search-path-created private trigger ignores public mutation", "CREATE SCHEMA private; SET search_path=private,public; CREATE TABLE trigger_audit(value integer); CREATE TABLE trigger_target(value integer); CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.created_path_inverse_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO private.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER created_path_inverse AFTER INSERT ON trigger_target FOR EACH ROW EXECUTE FUNCTION public.created_path_inverse_effect(); INSERT INTO public.trigger_target(value) VALUES (1);"],
    ["unqualified DROP clears private trigger", "CREATE SCHEMA private; CREATE TABLE private.trigger_audit(value integer); CREATE TABLE private.trigger_target(value integer); CREATE FUNCTION public.dropped_private_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO private.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER dropped_private AFTER INSERT ON private.trigger_target FOR EACH ROW EXECUTE FUNCTION public.dropped_private_effect(); SET search_path=private,public; DROP TRIGGER dropped_private ON trigger_target; INSERT INTO private.trigger_target(value) VALUES (1);"],
    ["unqualified rename and qualified DROP clear private trigger", "CREATE SCHEMA private; CREATE TABLE private.trigger_audit(value integer); CREATE TABLE private.trigger_target(value integer); CREATE FUNCTION public.renamed_drop_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO private.trigger_audit(value) VALUES (NEW.value); RETURN NEW; END $$; CREATE TRIGGER rename_old AFTER INSERT ON private.trigger_target FOR EACH ROW EXECUTE FUNCTION public.renamed_drop_effect(); SET search_path=private,public; ALTER TRIGGER rename_old ON trigger_target RENAME TO rename_new; DROP TRIGGER rename_new ON private.trigger_target; INSERT INTO private.trigger_target(value) VALUES (1);"],
    ["inert TRUNCATE and MERGE trigger keywords", "CREATE TABLE public.trigger_audit(value integer); CREATE TABLE public.trigger_target(value integer); CREATE FUNCTION public.inert_trigger_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.trigger_audit(value) VALUES (1); RETURN NULL; END $$; CREATE TRIGGER inert_effect AFTER TRUNCATE ON public.trigger_target FOR EACH STATEMENT EXECUTE FUNCTION public.inert_trigger_effect(); SELECT 'TRUNCATE TABLE public.trigger_target; MERGE INTO public.trigger_target';"],
    ["call-shaped quoted alias", "CREATE FUNCTION public.catalog_mutator() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$; SELECT 1 AS \"public.catalog_mutator()\";"],
    ["qualified call-shaped quoted column", "CREATE FUNCTION public.catalog_mutator() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$; SELECT x.\"public.catalog_mutator()\" FROM (SELECT 1 AS \"public.catalog_mutator()\") x;"],
    ["unqualified call-shaped quoted alias", "CREATE FUNCTION public.catalog_mutator() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$; SELECT 1 AS \"catalog_mutator()\";"],
    ["escaped call-shaped quoted alias", "CREATE FUNCTION public.catalog_mutator() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$; SELECT 1 AS \"public.catalog_mutator()\"\"quoted\";"],
    ["unrelated wrapper around a dynamic routine", "CREATE FUNCTION public.catalog_mutator() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN 1; END $body$; CREATE FUNCTION public.safe_wrapper() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$; SELECT public.safe_wrapper();"],
    ["unrelated INSERT and UPDATE expressions", "CREATE FUNCTION public.catalog_mutator() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN 1; END $body$; CREATE TABLE public.probe_sink(value integer); INSERT INTO public.probe_sink SELECT COALESCE(1, 1); UPDATE public.probe_sink SET value = COALESCE(value, 1);"],
    ["call-shaped CTAS literals", "CREATE FUNCTION public.catalog_mutator() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN 1; END $body$; CREATE TABLE public.probe_sink AS SELECT 'public.catalog_mutator()'::text AS value;"],
    ["inert Unicode-delimited identifier text", "SELECT 'ALTER TABLE U&\"publ\\0069c\".bookings'; SELECT $$ DROP INDEX U&\"publ\\0069c\".bookings_pkey $$; -- ALTER USER U&\"authent\\0069cated\" SET search_path=private;"],
    ["renamed-schema creation", "CREATE SCHEMA private; ALTER SCHEMA private RENAME TO private2; SET search_path=private2,pg_catalog; CREATE FUNCTION f() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;"],
    ["other-database role path", "ALTER ROLE authenticated IN DATABASE template1 SET search_path=private,public;"],
    ["private same-name index drop", "CREATE SCHEMA private; CREATE TABLE private.other(id uuid); CREATE INDEX bookings_pkey ON private.other(id); SET search_path=private,public; DROP INDEX bookings_pkey;"],
  ])("accepts reviewed provenance after proven non-catalog %s", (_shape, sql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      { file: "zzzz_non_catalog_control.sql", sql },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(true);
  });

  it("does not carry catalog taint across derivations or targets", () => {
    const tainted = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      { file: "zzzz_dynamic.sql", sql: "DO $$ BEGIN EXECUTE 'CREATE FUNCTION pg_catalog.probe() RETURNS int LANGUAGE sql AS ''SELECT 1'''; END $$;" },
    ]);
    const freshMain = derivePostgresMigrationProvenance(repoMigrations("main"));
    const freshRag = derivePostgresMigrationProvenance(repoMigrations("rag"));
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], tainted)).toBe(false);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], freshMain)).toBe(true);
    expect(postgresResourcesMatchReviewedProvenance(
      "rag",
      ["table:public.knowledge_chunks", "rpc:public.match_region_itinerary_chunks"],
      freshRag,
    )).toBe(true);
  });

  it("does not carry transitive dynamic-routine taint across derivations or targets", () => {
    const tainted = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      {
        file: "zzzz_dynamic_wrapper.sql",
        sql: "CREATE FUNCTION public.catalog_mutator() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'SELECT 1'; RETURN 1; END $$; " +
          "CREATE FUNCTION public.catalog_wrapper() RETURNS integer LANGUAGE sql AS $$ SELECT public.catalog_mutator() $$; " +
          "CREATE TABLE public.probe_sink(value integer); INSERT INTO public.probe_sink SELECT public.catalog_wrapper();",
      },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], tainted)).toBe(false);
    expect(postgresResourcesMatchReviewedProvenance(
      "main",
      ["table:public.bookings"],
      derivePostgresMigrationProvenance(repoMigrations("main")),
    )).toBe(true);
    expect(postgresResourcesMatchReviewedProvenance(
      "rag",
      ["table:public.knowledge_chunks", "rpc:public.match_region_itinerary_chunks"],
      derivePostgresMigrationProvenance(repoMigrations("rag")),
    )).toBe(true);
  });

  it("ignores catalog mutation text in comments, strings, identifiers, and dollar bodies", () => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      {
        file: "zzzz_inert.sql",
        sql: `
          -- ALTER ROUTINE public.auth_user_in_tenant(uuid) SET search_path = private;
          -- ALTER FUNCTION pg_catalog.texteq(text, text) NOT LEAKPROOF;
          SELECT 'CREATE OPERATOR public.= (LEFTARG = uuid, RIGHTARG = uuid)';
          SELECT 'DROP FUNCTION pg_catalog.texticlike(text, text) CASCADE';
          SELECT 'CREATE ACCESS METHOD evil TYPE INDEX HANDLER pg_catalog.bthandler';
          CREATE TABLE public."ALTER TABLE public.bookings OWNER TO attacker" (id uuid);
          CREATE FUNCTION public.inert_catalog_text() RETURNS text LANGUAGE plpgsql AS $body$
          BEGIN
            RETURN 'CREATE FUNCTION pg_catalog.unknown_guard_probe() RETURNS integer';
          END;
          $body$;
        `,
      },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(true);
  });

  it.each([
    ["column type", "ALTER TABLE public.bookings ALTER COLUMN id TYPE text USING id::text;"],
    ["column rename", "ALTER TABLE public.bookings RENAME COLUMN id TO replaced_id;"],
    ["forced RLS", "ALTER TABLE public.bookings FORCE ROW LEVEL SECURITY;"],
    ["unforced RLS", "ALTER TABLE public.bookings NO FORCE ROW LEVEL SECURITY;"],
    ["owner", "ALTER TABLE public.bookings OWNER TO authenticated;"],
    ["inheritance", "ALTER TABLE public.bookings INHERIT public.unrelated_rows;"],
    ["partition attachment", "ALTER TABLE public.bookings ATTACH PARTITION public.unrelated_rows DEFAULT;"],
    ["access method", "ALTER TABLE public.bookings SET ACCESS METHOD heap;"],
    ["rule state", "ALTER TABLE public.bookings DISABLE RULE bookings_read_effect;"],
    ["comment-separated RLS state", "ALTER/*probe*/ TABLE public.bookings DISABLE ROW LEVEL SECURITY;"],
  ])("rejects an unreviewed %s change on the reviewed relation", (_shape, sql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("main"),
      { file: "zzzz_relation_alter.sql", sql },
    ]);
    expect(postgresResourcesMatchReviewedProvenance("main", ["table:public.bookings"], provenance)).toBe(false);
  });

  it("rejects an unreviewed ALTER on a reviewed RAG relation", () => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("rag"),
      { file: "zzzz_relation_alter.sql", sql: "ALTER TABLE public.knowledge_chunks ALTER COLUMN id TYPE text USING id::text;" },
    ]);
    expect(postgresResourcesMatchReviewedProvenance(
      "rag",
      ["table:public.knowledge_chunks"],
      provenance,
    )).toBe(false);
  });

  it.each([
    ["effective body replacement", "CREATE OR REPLACE FUNCTION public.match_region_itinerary_chunks(p_region_terms text[], p_port_terms text[], p_date_from date, p_date_to date, p_origin_port_terms text[] DEFAULT '{}', p_limit integer DEFAULT 12) RETURNS TABLE (related_chunk_id uuid, first_departure date) LANGUAGE sql AS $$ DELETE FROM public.itineraries RETURNING related_chunk_id, departure_date $$;"],
    ["new overload", "CREATE FUNCTION public.match_region_itinerary_chunks(p_region_terms text[]) RETURNS TABLE (related_chunk_id uuid) LANGUAGE sql AS $$ SELECT NULL::uuid $$;"],
    ["ambiguous ALTER", "ALTER FUNCTION public.match_region_itinerary_chunks(text[], text[], date, date, text[], integer) RENAME TO replaced_match_region_itinerary_chunks;"],
    ["ALTER ROUTINE", "ALTER ROUTINE public.match_region_itinerary_chunks(text[], text[], date, date, text[], integer) SET search_path = private, public;"],
    ["DROP ROUTINE", "DROP ROUTINE public.match_region_itinerary_chunks(text[], text[], date, date, text[], integer);"],
    ["DROP FUNCTION aliases", "DROP FUNCTION public.match_region_itinerary_chunks(text ARRAY, text ARRAY, date, date, text ARRAY, int);"],
  ])("rejects reviewed RPC provenance after %s", (_shape, sql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("rag"),
      { file: "zzzz_effect.sql", sql },
    ]);
    expect(postgresResourcesMatchReviewedProvenance(
      "rag",
      ["rpc:public.match_region_itinerary_chunks"],
      provenance,
    )).toBe(false);
  });

  it("accepts an exact reviewed RPC recreated after DROP ROUTINE", () => {
    const migrations = repoMigrations("rag");
    const latest = migrations.find(({ file }) => file === "0033_region_itinerary_segment_match.sql");
    expect(latest).toBeDefined();
    const provenance = derivePostgresMigrationProvenance([
      ...migrations,
      { file: "zzzza_drop.sql", sql: "DROP ROUTINE public.match_region_itinerary_chunks(text[], text[], date, date, text[], integer);" },
      { file: "zzzzb_recreate.sql", sql: latest!.sql },
    ]);
    expect(postgresResourcesMatchReviewedProvenance(
      "rag",
      ["rpc:public.match_region_itinerary_chunks"],
      provenance,
    )).toBe(true);
  });

  it.each([
    ["drop", "DROP EXTENSION vector;"],
    ["update", "ALTER EXTENSION vector UPDATE;"],
    ["schema transfer", "ALTER EXTENSION vector SET SCHEMA extensions;"],
  ])("rejects RAG provenance after reviewed extension %s", (_shape, sql) => {
    const provenance = derivePostgresMigrationProvenance([
      ...repoMigrations("rag"),
      { file: "zzzz_extension.sql", sql },
    ]);
    expect(postgresResourcesMatchReviewedProvenance(
      "rag",
      ["rpc:public.match_region_itinerary_chunks"],
      provenance,
    )).toBe(false);
  });
});

describe("findMockedTenantTests", () => {
  it("flags an isolation-claiming test in a file that mocks @supabase/*", () => {
    const r = findMockedTenantTests(F, claimTest(`vi.mock("@supabase/supabase-js");`), EMPTY);
    expect(r).toHaveLength(1);
    expect(r[0]!.fullName).toMatch(/tenant isolation/);
  });

  it("flags a mock of a supabase-named local module", () => {
    expect(findMockedTenantTests(F, claimTest(`vi.mock("@/lib/db/supabase");`), EMPTY)).toHaveLength(1);
  });

  it("resolves a mocked local wrapper that creates the Supabase client", () => {
    const byPath = new Map([["apps/main/src/lib/db/client.ts", `import { createClient } from "@supabase/supabase-js";\nexport const db = createServerClient();`]]);
    expect(findMockedTenantTests(F, claimTest(`vi.mock("@/lib/db/client");`), byPath)).toHaveLength(1);
  });

  it("stays silent when the mock is partial (importActual — real code still runs)", () => {
    const src = claimTest(`vi.mock("@supabase/supabase-js", async (importOriginal) => ({ ...(await importOriginal()) }));`);
    expect(findMockedTenantTests(F, src, EMPTY)).toEqual([]);
  });

  it.each(["@supabase/supabase-js", "postgres"])(
    "flags a %s factory when one return path drops the original module",
    (specifier) => {
      const moduleMock = `vi.mock("${specifier}", async (importOriginal) => { if (process.env.PRESERVE_ORIGINAL) return { ...(await importOriginal()) }; return {}; });`;
      expect(findMockedTenantTests(F, claimTest(moduleMock), EMPTY)).toHaveLength(1);
    },
  );

  it.each(["@supabase/supabase-js", "postgres"])(
    "flags a %s concise conditional factory when one branch drops the original module",
    (specifier) => {
      const moduleMock = `vi.mock("${specifier}", async (importOriginal) => process.env.PRESERVE_ORIGINAL ? { ...(await importOriginal()) } : {});`;
      expect(findMockedTenantTests(F, claimTest(moduleMock), EMPTY)).toHaveLength(1);
    },
  );

  it.each([
    [
      "implicit fallthrough",
      "async (importOriginal) => { if (process.env.PRESERVE_ORIGINAL) return { ...(await importOriginal()) }; }",
    ],
    [
      "throw path",
      'async (importOriginal) => { if (process.env.PRESERVE_ORIGINAL) return { ...(await importOriginal()) }; throw new Error("unavailable"); }',
    ],
  ])("flags a Supabase factory with an unsafe %s", (_shape, factory) => {
    expect(findMockedTenantTests(F, claimTest(`vi.mock("@supabase/supabase-js", ${factory});`), EMPTY)).toHaveLength(1);
  });

  it.each(["@supabase/supabase-js", "postgres"])(
    "accepts a %s factory when every conditional branch preserves the original module",
    (specifier) => {
      const moduleMock = `vi.mock("${specifier}", async (importOriginal) => { if (process.env.FIRST_SHAPE) return { ...(await importOriginal()), first: true }; return { ...(await importOriginal()), second: true }; });`;
      expect(findMockedTenantTests(F, claimTest(moduleMock), EMPTY)).toEqual([]);
    },
  );

  it.each([
    ["Supabase", "@supabase/supabase-js"],
    ["Postgres", "postgres"],
  ])("rejects %s factories whose original loader provenance is mutated", (_kind, specifier) => {
    for (const [_shape, mutation, callee] of MUTATED_LOADER_FACTORIES) {
      const factory = `async (loader) => { const fake = async () => ({}); ${mutation} return { ...(await ${callee}()) }; }`;
      expect(findMockedTenantTests(F, claimTest(`vi.mock("${specifier}", ${factory});`), EMPTY)).toHaveLength(1);
    }
  });

  it.each([
    ["Supabase", "@supabase/supabase-js"],
    ["Postgres", "postgres"],
  ])("accepts %s factories with proven restored or immutable loaders", (_kind, specifier) => {
    for (const [_shape, setup, callee] of PROVEN_LOADER_FACTORIES) {
      const factory = `async (loader) => { const fake = async () => ({}); ${setup} return { ...(await ${callee}()) }; }`;
      expect(findMockedTenantTests(F, claimTest(`vi.mock("${specifier}", ${factory});`), EMPTY)).toEqual([]);
    }
  });

  it.each([
    ["Supabase", "@supabase/supabase-js"],
    ["Postgres", "postgres"],
  ])("rejects %s factories whose loader is mutated through a callable", (_kind, specifier) => {
    for (const [_shape, invocation] of MUTATOR_CALL_FACTORIES) {
      const factory = `async (loader) => { const fake = async () => ({}); ${invocation} return { ...(await loader()) }; }`;
      expect(findMockedTenantTests(F, claimTest(`vi.mock("${specifier}", ${factory});`), EMPTY)).toHaveLength(1);
    }
  });

  it.each([
    ["Supabase", "@supabase/supabase-js"],
    ["Postgres", "postgres"],
  ])("accepts %s factories after callables leave the loader proven", (_kind, specifier) => {
    for (const [_shape, invocation] of SAFE_CALL_FACTORIES) {
      const factory = `async (loader) => { const fake = async () => ({}); ${invocation} return { ...(await loader()) }; }`;
      expect(findMockedTenantTests(F, claimTest(`vi.mock("${specifier}", ${factory});`), EMPTY)).toEqual([]);
    }
  });

  it.each([
    ["bare loader mention", `vi.mock("@supabase/supabase-js", async (importOriginal) => ({ note: importOriginal.name }));`],
    ["unrelated actual call", `vi.mock("@supabase/supabase-js", async (loadReal) => { await loadReal(); return {}; });`],
  ])("flags an async Supabase mock that does not preserve the real factory via a %s", (_shape, moduleMock) => {
    expect(findMockedTenantTests(F, claimTest(moduleMock), EMPTY)).toHaveLength(1);
  });

  it("flags an async Postgres mock that drops the real default factory", () => {
    const source = claimTest(`vi.mock("postgres", async (requireActual) => ({ helper: requireActual }));`);
    expect(findMockedTenantTests(F, source, EMPTY)).toHaveLength(1);
  });

  it.each([
    [
      "computed export",
      `vi.mock("@supabase/supabase-js", async (importOriginal) => ({ ...(await importOriginal()), ["createClient"]: vi.fn() }));`,
    ],
    [
      "method export",
      `vi.mock("@supabase/supabase-js", async (importOriginal) => ({ ...(await importOriginal()), createClient() {} }));`,
    ],
    [
      "spread export",
      `const replacements = { createClient: vi.fn() };\nvi.mock("@supabase/supabase-js", async (importOriginal) => ({ ...(await importOriginal()), ...replacements }));`,
    ],
  ])("flags a partial Supabase mock that replaces createClient via a %s", (_shape, moduleMock) => {
    expect(findMockedTenantTests(F, claimTest(moduleMock), EMPTY)).toHaveLength(1);
  });

  it("flags a partial Postgres mock that replaces the default factory", () => {
    const source = claimTest(
      `vi.mock("postgres", async (importOriginal) => ({ ...(await importOriginal()), ["default"]: vi.fn() }));`,
    );
    expect(findMockedTenantTests(F, source, EMPTY)).toHaveLength(1);
  });

  it.each([
    ["Supabase", "@supabase/supabase-js"],
    ["Postgres", "postgres"],
  ])("flags a partial %s mock with an unknown computed replacement key", (_kind, specifier) => {
    const source = claimTest(
      `const replacementName = process.env.REPLACEMENT_NAME!;\nvi.mock("${specifier}", async (importOriginal) => ({ ...(await importOriginal()), [replacementName]: vi.fn() }));`,
    );
    expect(findMockedTenantTests(F, source, EMPTY)).toHaveLength(1);
  });

  it.each(["@supabase/supabase-js", "postgres"])(
    "accepts a partial %s mock with a statically unrelated computed key",
    (specifier) => {
      const source = claimTest(
        `vi.mock("${specifier}", async (importOriginal) => ({ ...(await importOriginal()), ["helper" + "Fn"]: vi.fn() }));`,
      );
      expect(findMockedTenantTests(F, source, EMPTY)).toEqual([]);
    },
  );

  it.each([
    ["Supabase", "@supabase/supabase-js", "createClient"],
    ["Postgres", "postgres", "default"],
  ])("rejects ordered trailing %s spread overrides", (_kind, specifier, protectedExport) => {
    const factories = [
      `async (importOriginal) => ({ ...(await importOriginal()), ...runtimeOverrides })`,
      `async (importOriginal) => ({ ...(await importOriginal()), ...getRuntimeOverrides() })`,
      `async (importOriginal) => ({ ...(await importOriginal()), ...{ ...runtimeOverrides } })`,
      `async (importOriginal) => ({ ...(await importOriginal()), ...(process.env.USE_OVERRIDE ? {} : { ${protectedExport}: vi.fn() }) })`,
      `async (importOriginal) => { const replacements = { ${protectedExport}: vi.fn() }; return { ...(await importOriginal()), ...replacements }; }`,
    ];
    for (const factory of factories) {
      expect(findMockedTenantTests(F, claimTest(`vi.mock("${specifier}", ${factory});`), EMPTY)).toHaveLength(1);
    }
  });

  it.each([
    ["Supabase", "@supabase/supabase-js", "createClient"],
    ["Postgres", "postgres", "default"],
  ])("accepts ordered %s spreads when the protected export finishes original", (_kind, specifier, protectedExport) => {
    const factories = [
      `async (importOriginal) => ({ ...runtimeOverrides, ...(await importOriginal()) })`,
      `async (importOriginal) => ({ ${protectedExport}: vi.fn(), ...(await importOriginal()) })`,
      `async (importOriginal) => { const helpers = { helper: vi.fn() }; return { ...(await importOriginal()), ...helpers }; }`,
      `async (importOriginal) => ({ ...(await importOriginal()), ...(process.env.FIRST_SHAPE ? { helper: true } : { other: true }) })`,
      `async (importOriginal) => ({ ...(await importOriginal()), metadata: { ${protectedExport}: vi.fn() } })`,
    ];
    for (const factory of factories) {
      expect(findMockedTenantTests(F, claimTest(`vi.mock("${specifier}", ${factory});`), EMPTY)).toEqual([]);
    }
  });

  it("stays silent on a DB mock when no test claims isolation coverage", () => {
    const src = `
import { vi, it } from "vitest";
vi.mock("@supabase/supabase-js");
it("formats the note title", () => {});
`;
    expect(findMockedTenantTests(F, src, EMPTY)).toEqual([]);
  });

  it("stays silent on an isolation claim when nothing DB-shaped is mocked", () => {
    const src = `
import { vi, it } from "vitest";
vi.mock("@/lib/email/send");
it("drops another tenant's rows (second isolation layer)", () => {});
`;
    expect(findMockedTenantTests(F, src, EMPTY)).toEqual([]);
  });

  it("exempts skipped tests (they cannot fail by design)", () => {
    const src = `
import { vi, it } from "vitest";
vi.mock("@supabase/supabase-js");
it.skip("enforces tenant isolation", () => {});
`;
    expect(findMockedTenantTests(F, src, EMPTY)).toEqual([]);
  });

  it("matches the claim in an enclosing describe title", () => {
    const src = `
import { vi, describe, it } from "vitest";
vi.mock("@supabase/supabase-js");
describe("cross-tenant probe", () => { it("returns nothing", () => {}); });
`;
    expect(findMockedTenantTests(F, src, EMPTY)).toHaveLength(1);
  });

  it("ignores non-test files", () => {
    expect(findMockedTenantTests("apps/main/src/lib/db/client.ts", claimTest(`vi.mock("@supabase/ssr");`), EMPTY)).toEqual([]);
  });

  it("accepts a directly attached pointer to a runnable real-DB integration test", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const files = new Map([[RLS_FILE, REAL_DB_COVERAGE]]);
    expect(findMockedTenantTests(F, source, files)).toEqual([]);
  });

  it("rejects a fake query receiver despite unused real-DB imports and configuration", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const fakeCoverage = `
import { createClient } from "@supabase/supabase-js";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
const DB_URL = process.env.SUPABASE_DB_URL;
const fake = {
  from: () => ({ select: () => Promise.resolve({ data: [], error: null }) }),
};
describe("RLS integration", () => {
  it("bookings: userB cannot SELECT tenantA rows", async () => {
    await assertIsolationQuery({
      query: () => fake.from("bookings").select("id"),
      allowedIds: [],
      deniedIds: ["booking-a"],
    });
  });
});
`;
    const result = findMockedTenantTests(F, source, new Map([[RLS_FILE, fakeCoverage]]));
    expect(result[0]?.annotationError).toMatch(/resource mismatch.*queried none/);
  });

  it("rejects a fake Supabase client shadowing a proven outer binding", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const shadowed = REAL_DB_COVERAGE
      .replace(
        'describe("RLS integration", () => {',
        'const db = createClient("https://db.example.test", "anon-key");\ndescribe("RLS integration", () => {',
      )
      .replace(
        '    const db = createClient("https://db.example.test", "anon-key");',
        '    const db = { from: () => ({ select: async () => ({ data: [], error: null }) }) } as never;',
      );
    const result = findMockedTenantTests(F, source, new Map([[RLS_FILE, shadowed]]));
    expect(result[0]?.annotationError).toMatch(/resource mismatch.*queried none/);
  });

  it("rejects a proven Supabase binding after an unproven overwrite", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const overwritten = REAL_DB_COVERAGE.replace(
      '    const db = createClient("https://db.example.test", "anon-key");',
      '    let db = createClient("https://db.example.test", "anon-key");\n    db = { from: () => ({ select: async () => ({ data: [], error: null }) }) } as never;',
    );
    const result = findMockedTenantTests(F, source, new Map([[RLS_FILE, overwritten]]));
    expect(result[0]?.annotationError).toMatch(/resource mismatch.*queried none/);
  });

  it.each([
    ["compound assignment", "db += fake;"],
    ["logical assignment", "db &&= fake;"],
    ["array destructuring assignment", "[db] = [fake];"],
    ["object destructuring assignment", "({ db } = { db: fake });"],
    ["update expression", "db++;"],
  ])("rejects a Supabase client after %s", (_shape, mutation) => {
    const coverage = REAL_DB_COVERAGE.replace(
      '    const db = createClient("https://db.example.test", "anon-key");',
      `    let db = createClient("https://db.example.test", "anon-key");\n    const fake = {} as never;\n    ${mutation}`,
    );
    expect(annotationErrorFor(coverage)).toMatch(/resource mismatch.*queried none/);
  });

  it("accepts a Supabase client after definite restoration", () => {
    const coverage = REAL_DB_COVERAGE.replace(
      '    const db = createClient("https://db.example.test", "anon-key");',
      '    let db = createClient("https://db.example.test", "anon-key");\n    const real = db;\n    db = {} as never;\n    db = real;',
    );
    expect(annotationErrorFor(coverage)).toBeUndefined();
  });

  it("accepts Supabase factory imports, helper returns, and client aliases", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const helperCoverage = REAL_DB_COVERAGE
      .replace("import { createClient }", "import { createClient as makeClient }")
      .replace(
        'describe("RLS integration", () => {',
        'async function authedClient() { return makeClient("https://db.example.test", "anon-key"); }\ndescribe("RLS integration", () => {',
      )
      .replace('const db = createClient("https://db.example.test", "anon-key");', "const db = await authedClient();\n    const alias = db;")
      .replace('db.from("bookings")', 'alias.from("bookings")');
    expect(findMockedTenantTests(F, source, new Map([[RLS_FILE, helperCoverage]]))).toEqual([]);
  });

  it.each([
    ["IIFE parameter", "createClient", "() => ({ from: () => ({ select: async () => ({ data: [], error: null }) }) })"],
    ["destructured IIFE parameter", "{ createClient }", "{ createClient: () => ({ from: () => ({ select: async () => ({ data: [], error: null }) }) }) }"],
  ])("rejects a fake Supabase factory supplied through an %s", (_shape, parameter, argument) => {
    const shadowed = REAL_DB_COVERAGE
      .replace('describe("RLS integration", () => {', `((${parameter}) => {\ndescribe("RLS integration", () => {`)
      .replace("  });\n});\n", `  });\n});\n})(${argument});\n`);
    expect(annotationErrorFor(shadowed)).toMatch(/resource mismatch.*queried none/);
  });

  it("rejects a fake Supabase factory supplied through a default parameter", () => {
    const shadowed = REAL_DB_COVERAGE
      .replace(
        'describe("RLS integration", () => {',
        '((createClient = () => ({ from: () => ({ select: async () => ({ data: [], error: null }) }) })) => {\ndescribe("RLS integration", () => {',
      )
      .replace("  });\n});\n", "  });\n});\n})(undefined);\n");
    expect(annotationErrorFor(shadowed)).toMatch(/resource mismatch.*queried none/);
  });

  it.each([
    ["direct object", "{ createClient }", "{ createClient: () => ({}) }"],
    ["nested object", "{ client: { createClient } }", "{ client: { createClient: () => ({}) } }"],
    ["defaulted object", "{ createClient = () => ({}) }", "{}"],
    ["object rest", "{ ...createClient }", "{ createClient: () => ({}) }"],
    ["array rest", "[...createClient]", "[() => ({})]"],
  ])("rejects a fake Supabase factory from block-local %s destructuring", (_shape, pattern, value) => {
    const shadowed = REAL_DB_COVERAGE
      .replace('describe("RLS integration", () => {', `{\nconst ${pattern} = ${value};\ndescribe("RLS integration", () => {`)
      .replace("  });\n});\n", "  });\n});\n}\n");
    expect(annotationErrorFor(shadowed)).toMatch(/resource mismatch.*queried none/);
  });

  it("keeps the imported Supabase factory proven when destructuring binds a different local name", () => {
    const coverage = REAL_DB_COVERAGE.replace(
      'describe("RLS integration", () => {',
      'const { createClient: fakeFactory } = { createClient: () => ({}) };\ndescribe("RLS integration", () => {',
    );
    expect(annotationErrorFor(coverage)).toBeUndefined();
  });

  it("accepts Postgres factory assignment and query aliases", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const postgresCoverage = `
import pgFactory from "postgres";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
const DB_URL = process.env.SUPABASE_DB_URL;
let sql;
sql = pgFactory(DB_URL!);
const queryDb = sql;
describe("RLS integration", () => {
  it("bookings: userB cannot SELECT tenantA rows", async () => {
    await assertIsolationQuery({
      query: () => queryDb\`SELECT id FROM public.bookings\`,
      allowedIds: [],
      deniedIds: ["booking-a"],
    });
  });
});
`;
    expect(findMockedTenantTests(F, source, new Map([[RLS_FILE, postgresCoverage]]))).toEqual([]);
  });

  it("accepts a locally defined helper returning an aliased Postgres factory client", () => {
    const helperCoverage = `
import { default as pgFactory } from "postgres";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
const DB_URL = process.env.SUPABASE_DB_URL;
function makeTenantClient() { return pgFactory(DB_URL!); }
const helper = makeTenantClient;
describe("RLS integration", () => {
  it("bookings: userB cannot SELECT tenantA rows", async () => {
    const sql = helper();
    const query = sql;
    await assertIsolationQuery({ query: () => query\`SELECT id FROM public.bookings\`, allowedIds: [], deniedIds: ["booking-a"] });
  });
});
`;
    expect(annotationErrorFor(helperCoverage)).toBeUndefined();
  });

  it("accepts additional proven read-only Postgres statements", () => {
    expect(postgresAnnotationErrorFor(
      'async () => { await sql`SELECT id FROM public.bookings`; return sql`SELECT id FROM public.bookings`; }',
    )).toBeUndefined();
  });

  it("accepts a resource-free Postgres SELECT before the proof query", () => {
    expect(postgresAnnotationErrorFor(
      'async () => { await sql`SELECT 1`; return sql`SELECT id FROM public.bookings`; }',
    )).toBeUndefined();
  });

  it.each([
    ["ANY array comparison", "SELECT id FROM public.bookings WHERE id = ANY (ARRAY['booking-a'])"],
    ["ALL array comparison", "SELECT id FROM public.bookings WHERE id = ALL (ARRAY['booking-a'])"],
    ["SOME array comparison", "SELECT id FROM public.bookings WHERE id = SOME (ARRAY['booking-a'])"],
    ["CASE grouping", "SELECT id FROM public.bookings WHERE CASE WHEN true THEN (id IS NOT NULL) ELSE (id IS NULL) END"],
    ["simple CASE operand grouping", "SELECT id FROM public.bookings WHERE CASE (id) WHEN ('booking-a') THEN (true) ELSE (true) END"],
    ["row constructors", "SELECT id FROM public.bookings WHERE ROW(id) = ROW('booking-a')"],
    ["array subquery constructor", "SELECT id FROM public.bookings WHERE id = ANY (ARRAY(SELECT id FROM public.bookings))"],
    ["CUBE grouping", "SELECT id FROM public.bookings GROUP BY CUBE (id)"],
    ["ROLLUP grouping", "SELECT id FROM public.bookings GROUP BY ROLLUP (id)"],
    ["GROUPING SETS", "SELECT id FROM public.bookings GROUP BY GROUPING SETS ((id), ())"],
    ["COALESCE value expression", "SELECT COALESCE(id, id) AS id FROM public.bookings"],
    ["NULLIF value expression", "SELECT NULLIF(id, 'unrelated') AS id FROM public.bookings"],
    ["GREATEST value expression", "SELECT GREATEST(id, id) AS id FROM public.bookings"],
    ["LEAST value expression", "SELECT LEAST(id, id) AS id FROM public.bookings"],
    ["CTE column aliases", "WITH visible(id) AS (SELECT id FROM public.bookings) SELECT id FROM visible"],
    ["table column aliases", "SELECT booking.id FROM public.bookings booking(id)"],
    ["derived-table column aliases", "SELECT visible.id FROM (SELECT id FROM public.bookings) visible(id)"],
    ["parenthesized INTERSECT operand", "SELECT id FROM public.bookings INTERSECT (SELECT id FROM public.bookings)"],
    ["parenthesized EXCEPT operand", "SELECT id FROM public.bookings EXCEPT (SELECT id FROM public.bookings)"],
    ["FETCH FIRST count", "SELECT id FROM public.bookings FETCH FIRST (1) ROWS ONLY"],
    ["FETCH NEXT count", "SELECT id FROM public.bookings FETCH NEXT (1) ROWS ONLY"],
    ["grouped BETWEEN operands", "SELECT id FROM public.bookings WHERE id BETWEEN ('a') AND ('z')"],
    ["AT TIME ZONE operand", "SELECT id FROM public.bookings WHERE CURRENT_TIMESTAMP AT TIME ZONE ('UTC') IS NOT NULL"],
    ["time precision", "SELECT id FROM public.bookings WHERE CURRENT_TIME(3) IS NOT NULL AND CURRENT_TIMESTAMP(3) IS NOT NULL AND LOCALTIME(3) IS NOT NULL AND LOCALTIMESTAMP(3) IS NOT NULL"],
    ["DISTINCT ON expression", "SELECT DISTINCT ON (id) id FROM public.bookings"],
    ["WINDOW definition", "SELECT id FROM public.bookings WINDOW booking_window AS (PARTITION BY id)"],
    ["LIMIT and OFFSET expressions", "SELECT id FROM public.bookings LIMIT (1) OFFSET (0)"],
    ["EXISTS subquery", "SELECT id FROM public.bookings WHERE EXISTS (SELECT 1 FROM public.bookings visible WHERE visible.id = id)"],
  ])("accepts Postgres %s syntax without treating it as a function", (_shape, statement) => {
    expect(postgresAnnotationErrorFor(`async () => sql\`${statement}\``)).toBeUndefined();
  });

  it("accepts the verified read-only region-matching Postgres function", () => {
    expect(postgresAnnotationErrorFor(
      'async () => sql`SELECT kc.id FROM public.match_region_itinerary_chunks(ARRAY[]::text[], ARRAY[]::text[], CURRENT_DATE, CURRENT_DATE) matched JOIN public.knowledge_chunks kc ON true`',
      "",
      "rpc:public.match_region_itinerary_chunks,table:public.knowledge_chunks",
    )).toBeUndefined();
  });

  it("accepts a reviewed base-table query bound to effective policy and function definitions", () => {
    expect(postgresAnnotationErrorFor('async () => sql`SELECT id FROM public.bookings`')).toBeUndefined();
  });

  it.each([
    ["block comment", "SELECT /* harmless */ id FROM public.bookings"],
    ["nested block comment", "SELECT /* outer /* nested */ harmless */ id FROM public.bookings"],
    ["line comment", "SELECT -- harmless\n id FROM public.bookings"],
    ["trailing line comment", "SELECT id FROM public.bookings -- harmless"],
    ["comment between adjacent tokens", "SELECT id/* harmless */FROM public.bookings"],
    ["comment after schema punctuation", "SELECT id FROM public./* harmless */bookings"],
    ["comment before schema punctuation", "SELECT id FROM public/* harmless */.bookings"],
    ["comment before a trailing terminator", "SELECT id FROM public.bookings/* harmless */;"],
    ["comment after an opening parenthesis", "SELECT id FROM public.bookings WHERE (/* harmless */id IS NOT NULL)"],
    ["comment after a comma", "SELECT COALESCE(id,/* harmless */id) AS id FROM public.bookings"],
  ])("accepts reviewed SQL with a harmless %s", (_shape, statement) => {
    expect(postgresAnnotationErrorFor(`async () => sql\`${statement}\``)).toBeUndefined();
  });

  it.each([
    ["unterminated block comment", "SELECT id FROM public.bookings /* unterminated"],
    ["quoted comment marker", "SELECT '/* not a comment */' AS id FROM public.bookings"],
    ["quoted line-comment marker", 'SELECT "--not-a-comment" AS id FROM public.bookings'],
    ["dollar-quoted comment marker", "SELECT $$/* not a comment */$$ AS id FROM public.bookings"],
    ["comment that separates one keyword", "SE/* not SELECT */LECT id FROM public.bookings"],
  ])("rejects unreviewed SQL at a %s boundary", (_shape, statement) => {
    expect(postgresAnnotationErrorFor(`async () => sql\`${statement}\``)).toMatch(/mutation witness/);
  });

  it.each([
    ["unreviewed operator", "SELECT id + id AS id FROM public.bookings", RLS_RESOURCE],
    ["unreviewed JSON operator", "SELECT id FROM public.bookings WHERE metadata @> '{}'", RLS_RESOURCE],
    ["unreviewed cast", "SELECT id::public.effectful_id AS id FROM public.bookings", RLS_RESOURCE],
    ["materialized view", "SELECT tenant_id AS id FROM public.attribution_rollup", "table:public.attribution_rollup"],
    ["unproven foreign relation", "SELECT id FROM public.remote_bookings", "table:public.remote_bookings"],
    ["relation with unreviewed policy code", "SELECT id FROM public.policy_effect_rows", "table:public.policy_effect_rows"],
    ["safe-RPC name with a wrong overload", "SELECT related_chunk_id AS id FROM public.match_region_itinerary_chunks()", "rpc:public.match_region_itinerary_chunks"],
    ["catalog sampling method", "SELECT id FROM public.bookings TABLESAMPLE SYSTEM (10)", RLS_RESOURCE],
    ["SQL/XML expression", "SELECT XMLPARSE(DOCUMENT '<booking/>') AS id FROM public.bookings", RLS_RESOURCE],
    ["SQL/JSON expression", "SELECT JSON_OBJECT('id' VALUE id) AS id FROM public.bookings", RLS_RESOURCE],
  ])("rejects raw Postgres %s without reviewed executable provenance", (_shape, statement, resources) => {
    expect(postgresAnnotationErrorFor(`async () => sql\`${statement}\``, "", resources)).toMatch(/mutation witness/);
  });

  it.each(["VALUES (1)", "SHOW search_path", "TABLE public.bookings", "EXPLAIN SELECT id FROM public.bookings"])(
    "pins unsupported resource-free/read grammar: %s",
    (statement) => {
      expect(postgresAnnotationErrorFor(`async () => sql\`${statement}\``)).toMatch(/mutation witness/);
    },
  );

  it("does not let a reviewed query in another analysis authorize an unreviewed query", () => {
    expect(postgresAnnotationErrorFor('async () => sql`SELECT id FROM public.bookings`')).toBeUndefined();
    expect(postgresAnnotationErrorFor('async () => sql`SELECT id + id AS id FROM public.bookings`')).toMatch(/mutation witness/);
    expect(postgresAnnotationErrorFor('async () => sql`SELECT id FROM public.bookings`')).toBeUndefined();
  });

  it("does not normalize semantic whitespace inside a reviewed SQL literal", () => {
    expect(postgresAnnotationErrorFor(
      "async () => sql`SELECT 'INTO  public.bookings_copy' AS note, id FROM public.bookings`",
    )).toMatch(/mutation witness/);
  });

  it("rejects a query that combines reviewed objects from different database targets", () => {
    expect(postgresAnnotationErrorFor(
      'async () => sql`SELECT booking.id FROM public.match_region_itinerary_chunks(ARRAY[]::text[], ARRAY[]::text[], CURRENT_DATE, CURRENT_DATE) matched JOIN public.bookings booking ON true`',
      "",
      "rpc:public.match_region_itinerary_chunks,table:public.bookings",
    )).toMatch(/mutation witness/);
  });

  it.each([
    ["unreviewed operator before a returned proof", 'async () => { await sql`SELECT id + id AS id FROM public.bookings`; return sql`SELECT id FROM public.bookings`; }', ""],
    ["saved proof followed by an unreviewed view", 'async () => { const selected = sql`SELECT id FROM public.bookings`; await sql`SELECT tenant_id AS id FROM public.attribution_rollup`; return selected; }', ""],
    ["branch-only unreviewed cast", 'async () => { if (process.env.EFFECT) await sql`SELECT id::public.effectful_id AS id FROM public.bookings`; return sql`SELECT id FROM public.bookings`; }', ""],
    ["aliased helper for an unreviewed policy relation", 'async () => { await readEffect(); return sql`SELECT id FROM public.bookings`; }', 'const query = sql; const readEffect = () => query`SELECT id FROM public.policy_effect_rows`;'],
    ["Promise.all sampling query", 'async () => { await Promise.all([sql`SELECT id FROM public.bookings TABLESAMPLE SYSTEM (10)`, sql`SELECT id FROM public.bookings`]); return sql`SELECT id FROM public.bookings`; }', ""],
  ])("rejects provenance laundering through %s", (_shape, query, setup) => {
    expect(postgresAnnotationErrorFor(query, setup)).toMatch(/mutation witness/);
  });

  it.each([
    ["projected after the proof ID", 'async () => sql`SELECT id, public.increment_customer_chat_count(id, id, 30) AS side_effect FROM public.bookings`', ""],
    ["projected before the proof ID", 'async () => sql`SELECT public.increment_customer_chat_count(id, id, 30) AS side_effect, id FROM public.bookings`', ""],
    ["through a tag alias", 'async () => queryDb`SELECT id, public.increment_customer_chat_count(id, id, 30) FROM public.bookings`', "const queryDb = sql;"],
    ["through a local helper", "async () => readAndMutate()", 'const readAndMutate = () => sql`SELECT id, public.increment_customer_chat_count(id, id, 30) FROM public.bookings`;'],
    ["inside a read CTE", 'async () => sql`WITH effect AS MATERIALIZED (SELECT public.increment_customer_chat_count(id, id, 30) FROM public.bookings) SELECT id FROM public.bookings`', ""],
    ["before a returned saved SELECT", 'async () => { const selected = sql`SELECT id FROM public.bookings`; await sql`SELECT public.increment_customer_chat_count(id, id, 30) FROM public.bookings`; return selected; }', ""],
    ["on a branch before a returned SELECT", 'async () => { if (process.env.MUTATE) await sql`SELECT public.increment_customer_chat_count(id, id, 30) FROM public.bookings`; return sql`SELECT id FROM public.bookings`; }', ""],
  ])("rejects a schema-qualified Postgres function %s", (_shape, query, setup) => {
    expect(postgresAnnotationErrorFor(query, setup)).toMatch(/mutation witness/);
  });

  it.each([
    ["in a SELECT list", "SELECT id, public.increment_weather_usage() FROM public.bookings"],
    ["in a WHERE clause", "SELECT id FROM public.bookings WHERE public.increment_weather_usage() IS NOT NULL"],
    ["in an ORDER BY clause", "SELECT id FROM public.bookings ORDER BY public.increment_weather_usage()"],
    ["in a nested scalar SELECT", "SELECT id, (SELECT public.increment_weather_usage()) FROM public.bookings"],
  ])("rejects a repository mutator %s", (_shape, statement) => {
    expect(postgresAnnotationErrorFor(`async () => sql\`${statement}\``)).toMatch(/mutation witness/);
  });

  it.each([
    ["nextval", "nextval('booking_sequence')"],
    ["setval", "setval('booking_sequence', 2)"],
    ["set_config", "set_config('app.tenant_id', 'other', false)"],
    ["advisory lock", "pg_advisory_lock(42)"],
    ["transaction advisory lock", "pg_advisory_xact_lock(42)"],
    ["sleep", "pg_sleep(1)"],
    ["dblink execution", "dblink_exec('DELETE FROM public.bookings')"],
    ["unknown aggregate", "unknown_aggregate(id)"],
    ["unknown window function", "unknown_window(id) OVER ()"],
  ])("rejects the effectful Postgres %s function in a SELECT", (_shape, call) => {
    expect(postgresAnnotationErrorFor(
      `async () => sql\`SELECT id, ${call} FROM public.bookings\``,
    )).toMatch(/mutation witness/);
  });

  it("rejects a mutating Postgres function used as the query resource", () => {
    expect(postgresAnnotationErrorFor(
      'async () => sql`SELECT * FROM public.increment_customer_chat_count(NULL, NULL, 30)`',
      "",
      "rpc:public.increment_customer_chat_count",
    )).toMatch(/mutation witness/);
  });

  it("rejects a mutating Postgres function used as a lateral resource", () => {
    expect(postgresAnnotationErrorFor(
      'async () => sql`SELECT booking.id FROM public.bookings booking CROSS JOIN LATERAL public.increment_weather_usage() effect`',
      "",
      "rpc:public.increment_weather_usage,table:public.bookings",
    )).toMatch(/mutation witness/);
  });

  it("rejects a schema-qualified function whose quoted name resembles SQL syntax", () => {
    expect(postgresAnnotationErrorFor(
      'async () => sql`SELECT id, public."ROW"(id) FROM public.bookings`',
    )).toMatch(/mutation witness/);
  });

  it.each([
    ["unqualified FILTER", "filter(id)"],
    ["unqualified OVER", "over(id)"],
    ["qualified FILTER", "public.filter(id)"],
    ["qualified OVER", "public.over(id)"],
    ["qualified SELECT", "public.select(id)"],
    ["qualified WHERE", "public.where(id)"],
    ["qualified WITHIN", "public.within(id)"],
    ["qualified MATERIALIZED", "public.materialized(id)"],
    ["qualified newly accepted ANY", "public.any(id)"],
    ["qualified newly accepted ROW", "public.row(id)"],
    ["quoted ROW", '"row"(id)'],
    ["qualified quoted ANY", 'public."any"(id)'],
  ])("rejects a Postgres %s callable shape", (_shape, call) => {
    expect(postgresAnnotationErrorFor(
      `async () => sql\`SELECT id, ${call} FROM public.bookings\``,
    )).toMatch(/mutation witness/);
  });

  it("rejects an unknown set-returning function inside ROWS FROM", () => {
    expect(postgresAnnotationErrorFor(
      'async () => sql`SELECT booking.id FROM public.bookings booking, ROWS FROM (unknown_srf(booking.id)) effect`',
    )).toMatch(/mutation witness/);
  });

  it.each([
    ["aggregate FILTER", "unknown_aggregate(id) FILTER (WHERE id IS NOT NULL)"],
    ["ordered-set aggregate", "unknown_aggregate(id) WITHIN GROUP (ORDER BY id)"],
  ])("rejects an unknown Postgres %s", (_shape, expression) => {
    expect(postgresAnnotationErrorFor(
      `async () => sql\`SELECT id, ${expression} FROM public.bookings\``,
    )).toMatch(/mutation witness/);
  });

  it.each([
    ["INSERT", 'sql`INSERT INTO public.bookings (id) VALUES (\'booking-a\')`'],
    ["UPDATE", 'sql`UPDATE public.bookings SET status = \'changed\'`'],
    ["DELETE", 'sql`DELETE FROM public.bookings`'],
    ["UPSERT-equivalent", 'sql`INSERT INTO public.bookings (id) VALUES (\'booking-a\') ON CONFLICT (id) DO UPDATE SET status = \'changed\'`'],
    ["MERGE", 'sql`MERGE INTO public.bookings USING public.contacts ON false WHEN NOT MATCHED THEN INSERT DEFAULT VALUES`'],
    ["CALL", 'sql`CALL public.refresh_bookings()`'],
    ["DDL", 'sql`CREATE TABLE public.bookings_copy AS SELECT * FROM public.bookings`'],
    ["writable CTE", 'sql`WITH changed AS (DELETE FROM public.bookings RETURNING id) SELECT id FROM changed`'],
    ["multi-statement", 'sql`SELECT id FROM public.bookings; DELETE FROM public.bookings`'],
  ])("rejects a %s Postgres operation before a returned SELECT", (_shape, mutation) => {
    expect(postgresAnnotationErrorFor(
      `async () => { await ${mutation}; return sql\`SELECT id FROM public.bookings\`; }`,
    )).toMatch(/mutation witness/);
  });

  it.each([
    ["a saved SELECT followed by mutation", 'async () => { const selected = sql`SELECT id FROM public.bookings`; await sql`UPDATE public.bookings SET status = \'changed\'`; return selected; }', ""],
    ["a branch mutation", 'async () => { if (process.env.MUTATE) await sql`DELETE FROM public.bookings`; return sql`SELECT id FROM public.bookings`; }', ""],
    ["an aliased helper mutation", 'async () => { await mutate(); return sql`SELECT id FROM public.bookings`; }', 'const query = sql; const mutate = () => query`INSERT INTO public.bookings (id) VALUES (\'booking-a\')`;'],
    ["a Promise.all mutation", 'async () => { await Promise.all([sql`DELETE FROM public.bookings`, sql`SELECT id FROM public.bookings`]); return sql`SELECT id FROM public.bookings`; }', ""],
    ["an unsupported dynamic statement", 'async () => { await sql.unsafe(statement); return sql`SELECT id FROM public.bookings`; }', "const statement = process.env.SQL!;"],
  ])("rejects Postgres SELECT laundering after %s", (_shape, query, setup) => {
    expect(postgresAnnotationErrorFor(query, setup)).toMatch(/mutation witness/);
  });

  it.each([
    ["fake return despite inert real imports", "function makeTenantClient() { return (() => Promise.resolve([])) as never; }"],
    ["helper reassignment", "let makeTenantClient = () => postgres(DB_URL!); makeTenantClient = () => (() => Promise.resolve([])) as never;"],
    ["branch-ambiguous return", "function makeTenantClient() { if (process.env.USE_FAKE) return (() => Promise.resolve([])) as never; return postgres(DB_URL!); }"],
    ["shadowed factory", "function makeTenantClient(postgres = () => (() => Promise.resolve([]))) { return postgres(DB_URL!); }"],
  ])("rejects a Postgres helper with a %s", (_shape, helper) => {
    const helperCoverage = `
import postgres from "postgres";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
const DB_URL = process.env.SUPABASE_DB_URL;
${helper}
describe("RLS integration", () => {
  it("bookings: userB cannot SELECT tenantA rows", async () => {
    const sql = makeTenantClient();
    await assertIsolationQuery({ query: () => sql\`SELECT id FROM public.bookings\`, allowedIds: [], deniedIds: ["booking-a"] });
  });
});
`;
    expect(annotationErrorFor(helperCoverage)).toMatch(/resource mismatch.*queried none/);
  });

  it("rejects a helper-returned Postgres client overwritten before its query", () => {
    const helperCoverage = `
import postgres from "postgres";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
const DB_URL = process.env.SUPABASE_DB_URL;
const makeTenantClient = () => postgres(DB_URL!);
describe("RLS integration", () => {
  it("bookings: userB cannot SELECT tenantA rows", async () => {
    let sql = makeTenantClient();
    sql = (() => Promise.resolve([])) as never;
    await assertIsolationQuery({ query: () => sql\`SELECT id FROM public.bookings\`, allowedIds: [], deniedIds: ["booking-a"] });
  });
});
`;
    expect(annotationErrorFor(helperCoverage)).toMatch(/resource mismatch.*queried none/);
  });

  it("rejects a helper-returned Postgres client mocked at instance level", () => {
    const helperCoverage = `
import postgres from "postgres";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
import { vi } from "vitest";
const DB_URL = process.env.SUPABASE_DB_URL;
const makeTenantClient = () => postgres(DB_URL!);
describe("RLS integration", () => {
  it("bookings: userB cannot SELECT tenantA rows", async () => {
    const sql = makeTenantClient();
    vi.mocked(sql).mockImplementation(() => Promise.resolve([]));
    await assertIsolationQuery({ query: () => sql\`SELECT id FROM public.bookings\`, allowedIds: [], deniedIds: ["booking-a"] });
  });
});
`;
    expect(annotationErrorFor(helperCoverage)).toMatch(/mocks the Postgres client receiver at instance level/);
  });

  it.each([
    ["compound assignment", "sql += fake;"],
    ["logical assignment", "sql &&= fake;"],
    ["array destructuring assignment", "[sql] = [fake];"],
    ["object destructuring assignment", "({ sql } = { sql: fake });"],
    ["update expression", "sql++;"],
  ])("rejects a Postgres client after %s", (_shape, mutation) => {
    const postgresCoverage = `
import postgres from "postgres";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
const DB_URL = process.env.SUPABASE_DB_URL;
let sql = postgres(DB_URL!);
const fake = (() => Promise.resolve([])) as never;
${mutation}
describe("RLS integration", () => {
  it("bookings: userB cannot SELECT tenantA rows", async () => {
    await assertIsolationQuery({ query: () => sql\`SELECT id FROM public.bookings\`, allowedIds: [], deniedIds: ["booking-a"] });
  });
});
`;
    expect(annotationErrorFor(postgresCoverage)).toMatch(/resource mismatch.*queried none/);
  });

  it("accepts a Postgres client after definite restoration", () => {
    const postgresCoverage = `
import postgres from "postgres";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
const DB_URL = process.env.SUPABASE_DB_URL;
let sql = postgres(DB_URL!);
const real = sql;
sql = (() => Promise.resolve([])) as never;
sql = real;
describe("RLS integration", () => {
  it("bookings: userB cannot SELECT tenantA rows", async () => {
    await assertIsolationQuery({ query: () => sql\`SELECT id FROM public.bookings\`, allowedIds: [], deniedIds: ["booking-a"] });
  });
});
`;
    expect(annotationErrorFor(postgresCoverage)).toBeUndefined();
  });

  it("rejects a fake Postgres factory supplied through an IIFE parameter", () => {
    const postgresCoverage = `
import postgres from "postgres";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
const DB_URL = process.env.SUPABASE_DB_URL;
((postgres) => {
describe("RLS integration", () => {
  it("bookings: userB cannot SELECT tenantA rows", async () => {
    const sql = postgres(DB_URL!);
    await assertIsolationQuery({
      query: () => sql\`SELECT id FROM public.bookings\`,
      allowedIds: [],
      deniedIds: ["booking-a"],
    });
  });
});
})(() => (() => Promise.resolve([])));
`;
    expect(annotationErrorFor(postgresCoverage)).toMatch(/resource mismatch.*queried none/);
  });

  it.each([
    ["INSERT", 'async () => { const deniedId = "booking-a"; const deniedRows = [{ id: deniedId }]; const { error } = await db.from("bookings").insert(deniedRows).select("id"); if (error?.code !== "42501") throw new Error("expected denied insert"); const allowedRows = [{ id: "allowed" }]; return db.from("bookings").insert(allowedRows).select("id"); }'],
    ["UPDATE", '() => { const attemptedIds = ["allowed", "booking-a"]; return db.from("bookings").update({ status: "updated" }).in("id", attemptedIds).select("id"); }'],
    ["DELETE", '() => { const attemptedIds = ["allowed", "booking-a"]; return db.from("bookings").delete().in("id", attemptedIds).select("id"); }'],
    ["UPSERT", 'async () => { const deniedId = "booking-a"; const deniedRows = [{ id: deniedId }]; const denied = await db.from("bookings").upsert(deniedRows).select("id"); if (denied.error?.code !== "42501") throw new Error("expected denied upsert"); const allowedRows = [{ id: "allowed" }]; return db.from("bookings").upsert(allowedRows).select("id"); }'],
  ])("accepts %s evidence that returns affected row IDs from a proven receiver", (_mutation, query) => {
    const coverage = REAL_DB_COVERAGE
      .replace('query: () => db.from("bookings").select("id")', `query: ${query}`)
      .replace("allowedIds: []", 'allowedIds: ["allowed"]');
    expect(annotationErrorFor(coverage)).toBeUndefined();
  });

  const helperMutationCases = [
    ["UPDATE", 'const patch = { status: "updated" };', 'db.from("bookings").update(patch).in("id", ids).select("id")'],
    ["DELETE", "", 'db.from("bookings").delete().in("id", ids).select("id")'],
  ] as const;

  it.each(helperMutationCases)("accepts a single exact %s helper mutation", (_mutation, setup, operation) => {
    const query = `() => { ${setup} const mutate = (ids: string[]) => ${operation}; return mutate(["allowed", "booking-a"]); }`;
    const coverage = REAL_DB_COVERAGE
      .replace('query: () => db.from("bookings").select("id")', `query: ${query}`)
      .replace("allowedIds: []", 'allowedIds: ["allowed"]');
    expect(annotationErrorFor(coverage)).toBeUndefined();
  });

  it.each(helperMutationCases)("rejects an ignored %s helper mutation before an authoritative call", (_mutation, setup, operation) => {
    const query = `async () => { ${setup} const mutate = (ids: string[]) => ${operation}; await mutate(["unrelated"]); return mutate(["allowed", "booking-a"]); }`;
    const coverage = REAL_DB_COVERAGE
      .replace('query: () => db.from("bookings").select("id")', `query: ${query}`)
      .replace("allowedIds: []", 'allowedIds: ["allowed"]');
    expect(annotationErrorFor(coverage)).toMatch(/mutation witness/);
  });

  it.each(helperMutationCases)("rejects repeated identical valid %s helper mutations", (_mutation, setup, operation) => {
    const query = `async () => { ${setup} const mutate = (ids: string[]) => ${operation}; await mutate(["allowed", "booking-a"]); return mutate(["allowed", "booking-a"]); }`;
    const coverage = REAL_DB_COVERAGE
      .replace('query: () => db.from("bookings").select("id")', `query: ${query}`)
      .replace("allowedIds: []", 'allowedIds: ["allowed"]');
    expect(annotationErrorFor(coverage)).toMatch(/mutation witness/);
  });

  it.each(helperMutationCases)("rejects repeated %s mutations through a helper alias", (_mutation, setup, operation) => {
    const query = `async () => { ${setup} const mutate = (ids: string[]) => ${operation}; const alias = mutate; await alias(["unrelated"]); return mutate(["allowed", "booking-a"]); }`;
    const coverage = REAL_DB_COVERAGE
      .replace('query: () => db.from("bookings").select("id")', `query: ${query}`)
      .replace("allowedIds: []", 'allowedIds: ["allowed"]');
    expect(annotationErrorFor(coverage)).toMatch(/mutation witness/);
  });

  it.each(helperMutationCases)("rejects a branch-conditional earlier %s helper mutation", (_mutation, setup, operation) => {
    const query = `async () => { ${setup} const mutate = (ids: string[]) => ${operation}; if (process.env.RUN_MUTATION) await mutate(["unrelated"]); return mutate(["allowed", "booking-a"]); }`;
    const coverage = REAL_DB_COVERAGE
      .replace('query: () => db.from("bookings").select("id")', `query: ${query}`)
      .replace("allowedIds: []", 'allowedIds: ["allowed"]');
    expect(annotationErrorFor(coverage)).toMatch(/mutation witness/);
  });

  it.each([
    ["absent options", "", ""],
    ["an inline static id conflict target", "", ', { onConflict: "id" }'],
    ["an aliased static id conflict target", 'const options = { onConflict: "id" };', ", options"],
    ["a single-assignment const alias chain", 'const original = { onConflict: "id" }; const forwarded = original; const options = forwarded;', ", options"],
    ["a locally inspected static id target", 'const options = { onConflict: "id" }; function inspect(value: { onConflict: string }) { return value.onConflict; } inspect(options);', ", options"],
  ])("accepts UPSERT evidence with %s", (_shape, setup, options) => {
    const query = `async () => { ${setup} const denied = await db.from("bookings").upsert([{ id: "booking-a" }]${options}).select("id"); if (denied.error?.code !== "42501") throw new Error("expected denial"); return db.from("bookings").upsert([{ id: "allowed" }]${options}).select("id"); }`;
    const coverage = REAL_DB_COVERAGE
      .replace('query: () => db.from("bookings").select("id")', `query: ${query}`)
      .replace("allowedIds: []", 'allowedIds: ["allowed"]');
    expect(annotationErrorFor(coverage)).toBeUndefined();
  });

  it.each([
    ["an alternate conflict key", 'const options = { onConflict: "external_ref" };'],
    ["a composite conflict key", 'const options = { onConflict: "id,tenant_id" };'],
    ["a dynamic conflict key", "const options = { onConflict: process.env.CONFLICT_KEY };"],
    ["unresolved options", "const options = getOptions();"],
    ["branch-ambiguous options", 'const options = process.env.USE_ID ? { onConflict: "id" } : { onConflict: "external_ref" };'],
    ["a reassigned options alias", 'let options = { onConflict: "id" }; options = { onConflict: "external_ref" };'],
    ["an overwritten conflict key", 'const options = { onConflict: "external_ref" }; options.onConflict = "id";'],
    ["a restored original binding", 'const original = { onConflict: "id" }; let options = original; options = { onConflict: "external_ref" }; options = original;'],
    ["an alias overwritten away and back", 'const original = { onConflict: "id" }; let options = original; let alias = options; alias = { onConflict: "external_ref" }; alias = options;', "alias"],
    ["a branch overwrite followed by fresh restoration", 'let options = { onConflict: "id" }; if (process.env.USE_EXTERNAL) options = { onConflict: "external_ref" }; options = { onConflict: "id" };'],
    ["an external binding restored to a fresh id target", 'let options = { onConflict: "external_ref" }; options = { onConflict: "id" };'],
    ["a tainted alias chain", 'const original = { onConflict: "id" }; let options = original; options = { onConflict: "external_ref" }; options = original; const forwarded = options; const finalOptions = forwarded;', "finalOptions"],
    ["Object.setPrototypeOf", 'const options = { onConflict: "id" }; Object.setPrototypeOf(options, { onConflict: "external_ref" });'],
    ["Reflect.setPrototypeOf through an alias", 'const options = { onConflict: "id" }; const alias = options; Reflect.setPrototypeOf(alias, { onConflict: "external_ref" });'],
    ["a prototype literal", 'const options = { __proto__: { onConflict: "external_ref" } };'],
    ["Object.create with an inherited conflict target", 'const options = Object.create({ onConflict: "external_ref" });'],
    ["a __proto__ assignment", 'const options = { onConflict: "id" }; options.__proto__ = { onConflict: "external_ref" };'],
    ["defineProperty", 'const options = { onConflict: "id" }; Object.defineProperty(options, "onConflict", { value: "external_ref" });'],
    ["a resolved local prototype mutator", 'const options = { onConflict: "id" }; function mutate(value: object) { Object.setPrototypeOf(value, { onConflict: "external_ref" }); } mutate(options);'],
    ["an unresolved mutator", 'const options = { onConflict: "id" }; mutateOptions(options);'],
    ["a branch-local alias prototype mutation", 'const options = { onConflict: "id" }; const alias = options; if (process.env.MUTATE) Object.setPrototypeOf(alias, { onConflict: "external_ref" });'],
  ])("rejects UPSERT evidence with %s", (_shape, setup, options = "options") => {
    const query = `async () => { ${setup} const denied = await db.from("bookings").upsert([{ id: "booking-a" }], ${options}).select("id"); if (denied.error?.code !== "42501") throw new Error("expected denial"); return db.from("bookings").upsert([{ id: "allowed" }], ${options}).select("id"); }`;
    const coverage = REAL_DB_COVERAGE
      .replace('query: () => db.from("bookings").select("id")', `query: ${query}`)
      .replace("allowedIds: []", 'allowedIds: ["allowed"]');
    expect(annotationErrorFor(coverage)).toMatch(/mutation witness/);
  });

  it.each([
    ["INSERT", 'async () => { const denied = await db.from("bookings").insert([{ id: "booking-a" }]).select("id"); if (!denied.error) throw new Error("expected an error"); return db.from("bookings").insert([{ id: "allowed" }]).select("id"); }'],
    ["UPSERT", 'async () => { const denied = await db.from("bookings").upsert([{ id: "booking-a" }]).select("id"); if (!denied.error) throw new Error("expected an error"); return db.from("bookings").upsert([{ id: "allowed" }]).select("id"); }'],
  ])("rejects %s denial probes that do not prove an RLS policy error", (_mutation, query) => {
    const coverage = REAL_DB_COVERAGE
      .replace('query: () => db.from("bookings").select("id")', `query: ${query}`)
      .replace("allowedIds: []", 'allowedIds: ["allowed"]');
    expect(annotationErrorFor(coverage)).toMatch(/mutation witness/);
  });

  it.each([
    ["INSERT", 'db.from("bookings").insert([{ id: "allowed" }]).select("id")'],
    ["UPDATE", 'db.from("bookings").update({ status: "updated" }).eq("id", "allowed").select("id")'],
    ["DELETE", 'db.from("bookings").delete().eq("id", "allowed").select("id")'],
    ["UPSERT", 'db.from("bookings").upsert([{ id: "allowed" }]).select("id")'],
  ])("rejects %s evidence that never attempts the declared denied ID", (_mutation, query) => {
    const coverage = REAL_DB_COVERAGE
      .replace('query: () => db.from("bookings").select("id")', `query: () => ${query}`)
      .replace("allowedIds: []", 'allowedIds: ["allowed"]');
    expect(annotationErrorFor(coverage)).toMatch(/mutation witness/);
  });

  it.each([
    ["INSERT", 'async () => { const denied = await db.from("bookings").insert([{ id: "unrelated" }]).select("id"); if (denied.error?.code !== "42501") throw new Error("expected denial"); return db.from("bookings").insert([{ id: "allowed" }]).select("id"); }'],
    ["UPDATE", '() => db.from("bookings").update({ status: "updated" }).in("id", ["allowed", "unrelated"]).select("id")'],
    ["DELETE", '() => db.from("bookings").delete().in("id", ["allowed", "unrelated"]).select("id")'],
    ["UPSERT", 'async () => { const denied = await db.from("bookings").upsert([{ id: "unrelated" }]).select("id"); if (denied.error?.code !== "42501") throw new Error("expected denial"); return db.from("bookings").upsert([{ id: "allowed" }]).select("id"); }'],
  ])("rejects %s evidence that attempts an unrelated ID instead of the denied ID", (_mutation, query) => {
    const coverage = REAL_DB_COVERAGE
      .replace('query: () => db.from("bookings").select("id")', `query: ${query}`)
      .replace("allowedIds: []", 'allowedIds: ["allowed"]');
    expect(annotationErrorFor(coverage)).toMatch(/mutation witness/);
  });

  it.each([
    ["UPDATE", 'db.from("bookings").update({ status: "updated" }).in("id", ["allowed", "booking-a"]).neq("id", "booking-a").select("id")'],
    ["DELETE", 'db.from("bookings").delete().in("id", ["allowed", "booking-a"]).neq("id", "booking-a").select("id")'],
  ])("rejects %s evidence whose later filter removes the denied attempt", (_mutation, query) => {
    const coverage = REAL_DB_COVERAGE
      .replace('query: () => db.from("bookings").select("id")', `query: () => ${query}`)
      .replace("allowedIds: []", 'allowedIds: ["allowed"]');
    expect(annotationErrorFor(coverage)).toMatch(/mutation witness/);
  });

  it.each([
    ["INSERT", 'db.from("bookings").insert([{ id: "booking-a" }]).select("id")'],
    ["UPDATE", 'db.from("bookings").update({ status: "updated" }).eq("id", "booking-a").select("id")'],
    ["DELETE", 'db.from("bookings").delete().eq("id", "unrelated").select("id")'],
    ["UPSERT", 'db.from("bookings").upsert([{ id: "booking-a" }]).select("id")'],
  ])("rejects %s evidence with no declared allowed effect", (_mutation, query) => {
    const coverage = REAL_DB_COVERAGE.replace(
      'query: () => db.from("bookings").select("id")',
      `query: () => ${query}`,
    );
    expect(annotationErrorFor(coverage)).toMatch(/mutation witness/);
  });

  it.each([
    ["INSERT", 'async () => { const denied = await db.from("bookings").insert([{ id: "booking-a" }]).select("id"); if (denied.error?.code !== "42501") throw new Error("expected denial"); return db.from("bookings").insert([{ id: "allowed" }]).select("id"); }'],
    ["UPDATE", '() => db.from("bookings").update({ status: "updated" }).in("id", ["allowed", "booking-a"]).select("id")'],
    ["DELETE", '() => db.from("bookings").delete().in("id", ["allowed", "booking-a"]).select("id")'],
    ["UPSERT", 'async () => { const denied = await db.from("bookings").upsert([{ id: "booking-a" }]).select("id"); if (denied.error?.code !== "42501") throw new Error("expected denial"); return db.from("bookings").upsert([{ id: "allowed" }]).select("id"); }'],
  ])("rejects %s evidence whose declared returned IDs do not match the attempted allowed effect", (_mutation, query) => {
    const coverage = REAL_DB_COVERAGE
      .replace('query: () => db.from("bookings").select("id")', `query: ${query}`)
      .replace("allowedIds: []", 'allowedIds: ["other"]');
    expect(annotationErrorFor(coverage)).toMatch(/mutation witness/);
  });

  const mutationLaunderingCases = [
    ["INSERT", 'db.from("bookings").insert([{ id: "booking-a" }]).select("id")'],
    ["UPDATE", 'db.from("bookings").update({ status: "updated" }).eq("id", "unrelated").select("id")'],
    ["DELETE", 'db.from("bookings").delete().eq("id", "unrelated").select("id")'],
    ["UPSERT", 'db.from("bookings").upsert([{ id: "booking-a" }]).select("id")'],
  ] as const;

  it.each(mutationLaunderingCases)("rejects an ignored %s before a returned canonical SELECT", (_mutation, mutation) => {
    const query = `async () => { await ${mutation}; return db.from("bookings").select("id"); }`;
    const coverage = REAL_DB_COVERAGE.replace(
      'query: () => db.from("bookings").select("id")',
      `query: ${query}`,
    );
    expect(annotationErrorFor(coverage)).toMatch(/mutation witness/);
  });

  it.each(mutationLaunderingCases)("rejects a saved canonical SELECT followed by an unrelated %s", (_mutation, mutation) => {
    const query = `async () => { const selected = db.from("bookings").select("id"); await ${mutation}; return selected; }`;
    const coverage = REAL_DB_COVERAGE.replace(
      'query: () => db.from("bookings").select("id")',
      `query: ${query}`,
    );
    expect(annotationErrorFor(coverage)).toMatch(/mutation witness/);
  });

  it.each(mutationLaunderingCases)("rejects a branch-conditional aliased %s before a returned SELECT", (_mutation, mutation) => {
    const query = `async () => { const mutate = () => ${mutation}; if (process.env.RUN_MUTATION) await mutate(); return db.from("bookings").select("id"); }`;
    const coverage = REAL_DB_COVERAGE.replace(
      'query: () => db.from("bookings").select("id")',
      `query: ${query}`,
    );
    expect(annotationErrorFor(coverage)).toMatch(/mutation witness/);
  });

  it.each([
    ["INSERT", 'db.from("bookings").insert([{ id: "allowed" }])'],
    ["UPDATE", 'db.from("bookings").update({ status: "updated" }).eq("id", "allowed")'],
    ["DELETE", 'db.from("bookings").delete().eq("id", "allowed")'],
    ["UPSERT", 'db.from("bookings").upsert([{ id: "allowed" }])'],
  ])("rejects success-only %s results without affected-row evidence", (_mutation, query) => {
    const coverage = REAL_DB_COVERAGE.replace(
      'query: () => db.from("bookings").select("id")',
      `query: () => ${query}`,
    );
    expect(annotationErrorFor(coverage)).toMatch(/resource mismatch.*queried none|mutation witness/);
  });

  it.each([
    ["INSERT", 'db.from("bookings").insert([{ id: "allowed" }]).select("status")'],
    ["UPDATE", 'db.from("bookings").update({ status: "updated" }).eq("id", "allowed").select("status")'],
    ["DELETE", 'db.from("bookings").delete().eq("id", "allowed").select("status")'],
    ["UPSERT", 'db.from("bookings").upsert([{ id: "allowed" }]).select("status")'],
  ])("rejects %s results that do not return affected IDs", (_mutation, query) => {
    const coverage = REAL_DB_COVERAGE.replace(
      'query: () => db.from("bookings").select("id")',
      `query: () => ${query}`,
    );
    expect(annotationErrorFor(coverage)).toMatch(/resource mismatch.*queried none|mutation witness/);
  });

  it.each([
    ["INSERT", 'fake.from("bookings").insert([{ id: "allowed" }]).select("id")'],
    ["UPDATE", 'fake.from("bookings").update({ status: "updated" }).eq("id", "allowed").select("id")'],
    ["DELETE", 'fake.from("bookings").delete().eq("id", "allowed").select("id")'],
    ["UPSERT", 'fake.from("bookings").upsert([{ id: "allowed" }]).select("id")'],
  ])("rejects %s evidence from a fake receiver despite inert real-DB imports", (_mutation, query) => {
    const coverage = REAL_DB_COVERAGE
      .replace(
        '    const db = createClient("https://db.example.test", "anon-key");',
        "    createClient(\"https://db.example.test\", \"anon-key\");\n    const fake = {} as never;",
      )
      .replace('query: () => db.from("bookings").select("id")', `query: () => ${query}`);
    expect(annotationErrorFor(coverage)).toMatch(/resource mismatch.*queried none/);
  });

  it("preserves canonical SELECT evidence while mutation evidence is distinguished", () => {
    expect(annotationErrorFor(REAL_DB_COVERAGE)).toBeUndefined();
  });

  it("rejects a real from call nested under an unrelated select chain", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const unrelatedSelect = REAL_DB_COVERAGE.replace(
      'db.from("bookings").select("id")',
      'wrap(db.from("bookings")).select("id")',
    ).replace(
      'describe("RLS integration", () => {',
      'const wrap = (value: unknown) => ({ select: async () => value });\ndescribe("RLS integration", () => {',
    );
    const result = findMockedTenantTests(F, source, new Map([[RLS_FILE, unrelatedSelect]]));
    expect(result[0]?.annotationError).toMatch(/resource mismatch.*queried none/);
  });

  it("rejects a real query confined to a dead conditional branch", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const deadQuery = REAL_DB_COVERAGE.replace(
      'db.from("bookings").select("id")',
      'false ? db.from("bookings").select("id") : Promise.resolve({ data: [], error: null })',
    );
    const result = findMockedTenantTests(F, source, new Map([[RLS_FILE, deadQuery]]));
    expect(result[0]?.annotationError).toMatch(/resource mismatch.*queried none/);
  });

  it("rejects an overwritten Postgres binding", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const overwritten = `
import postgres from "postgres";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
const DB_URL = process.env.SUPABASE_DB_URL;
let sql = postgres(DB_URL!);
sql = (() => Promise.resolve([])) as never;
describe("RLS integration", () => {
  it("bookings: userB cannot SELECT tenantA rows", async () => {
    await assertIsolationQuery({
      query: () => sql\`SELECT id FROM public.bookings\`,
      allowedIds: [],
      deniedIds: ["booking-a"],
    });
  });
});
`;
    const result = findMockedTenantTests(F, source, new Map([[RLS_FILE, overwritten]]));
    expect(result[0]?.annotationError).toMatch(/resource mismatch.*queried none/);
  });

  it("rejects a shadowed Postgres binding with no factory provenance", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const shadowed = `
import postgres from "postgres";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
const DB_URL = process.env.SUPABASE_DB_URL;
const sql = postgres(DB_URL!);
describe("RLS integration", () => {
  it("bookings: userB cannot SELECT tenantA rows", async () => {
    const sql = (() => Promise.resolve([])) as never;
    await assertIsolationQuery({
      query: () => sql\`SELECT id FROM public.bookings\`,
      allowedIds: [],
      deniedIds: ["booking-a"],
    });
  });
});
`;
    const result = findMockedTenantTests(F, source, new Map([[RLS_FILE, shadowed]]));
    expect(result[0]?.annotationError).toMatch(/resource mismatch.*queried none/);
  });

  it("rejects a query parameter that shadows a proven Supabase client", () => {
    const shadowedQuery = REAL_DB_COVERAGE.replace(
      'query: () => db.from("bookings").select("id")',
      'query: (db = { from: () => ({ select: async () => ({ data: [], error: null }) }) } as never) => db.from("bookings").select("id")',
    );
    expect(annotationErrorFor(shadowedQuery)).toMatch(/query must be a zero-argument inline function/);
  });

  it.each([
    ["spy", 'vi.spyOn(alias, "from").mockReturnValue({ select: async () => ({ data: [], error: null }) } as never);'],
    [
      "property replacement",
      'vi.replaceProperty(alias, "from", () => ({ select: async () => ({ data: [], error: null }) }) as never);',
    ],
    [
      "direct method assignment",
      'alias.from = (() => ({ select: async () => ({ data: [], error: null }) })) as never;',
    ],
    [
      "computed method assignment",
      'alias["from"] = (() => ({ select: async () => ({ data: [], error: null }) })) as never;',
    ],
  ])("rejects a Supabase receiver alias changed through an instance %s", (_shape, mutation) => {
    const mockedReceiver = REAL_DB_COVERAGE.replace(
      "    await assertIsolationQuery({",
      `    const alias = db;\n    ${mutation}\n    await assertIsolationQuery({`,
    );
    expect(annotationErrorFor(mockedReceiver)).toMatch(/mocks the Supabase client receiver at instance level/);
  });

  it("rejects a mocked Postgres receiver alias", () => {
    const mockedReceiver = `
import postgres from "postgres";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
const DB_URL = process.env.SUPABASE_DB_URL;
const sql = postgres(DB_URL!);
const queryDb = sql;
vi.mocked(queryDb).mockImplementation(() => Promise.resolve([]));
describe("RLS integration", () => {
  it("bookings: userB cannot SELECT tenantA rows", async () => {
    await assertIsolationQuery({
      query: () => sql\`SELECT id FROM public.bookings\`,
      allowedIds: [],
      deniedIds: ["booking-a"],
    });
  });
});
`;
    expect(annotationErrorFor(mockedReceiver)).toMatch(/mocks the Postgres client receiver at instance level/);
  });

  it.each([
    ["skipIf(true)", "it.skipIf(true)"],
    ["skipIf(1)", "it.skipIf(1)"],
    ["runIf(false)", "it.runIf(false)"],
    ["runIf(0)", "it.runIf(0)"],
    ["it.each([])", "it.each([])"],
  ])("rejects a coverage target registered through the dead %s path", (_shape, registration) => {
    const disabled = REAL_DB_COVERAGE.replace(
      '  it("bookings: userB cannot SELECT tenantA rows", async () => {',
      `  ${registration}("bookings: userB cannot SELECT tenantA rows", async () => {`,
    );
    expect(annotationErrorFor(disabled)).toMatch(/coverage test not found/);
  });

  it("rejects a coverage target registered through an aliased empty each family", () => {
    const disabled = REAL_DB_COVERAGE
      .replace('describe("RLS integration", () => {', 'const noCases: unknown[] = [];\ndescribe("RLS integration", () => {')
      .replace(
        '  it("bookings: userB cannot SELECT tenantA rows", async () => {',
        '  it.each(noCases)("bookings: userB cannot SELECT tenantA rows", async () => {',
      );
    expect(annotationErrorFor(disabled)).toMatch(/coverage test not found/);
  });

  it("rejects an isolation witness inside if (false)", () => {
    const conditional = REAL_DB_COVERAGE.replace(
      "    await assertIsolationQuery({",
      "    if (false) await assertIsolationQuery({",
    );
    expect(annotationErrorFor(conditional)).toMatch(/unconditional top-level statement/);
  });

  it("rejects an isolation witness behind short-circuit evaluation", () => {
    const conditional = REAL_DB_COVERAGE.replace(
      "    await assertIsolationQuery({",
      "    false && (await assertIsolationQuery({",
    ).replace("    });\n  });", "    }));\n  });");
    expect(annotationErrorFor(conditional)).toMatch(/unconditional top-level statement/);
  });

  it("rejects an isolation witness in a zero-iteration loop", () => {
    const conditional = REAL_DB_COVERAGE.replace(
      "    await assertIsolationQuery({",
      "    for (; false; ) await assertIsolationQuery({",
    );
    expect(annotationErrorFor(conditional)).toMatch(/unconditional top-level statement/);
  });

  it("rejects an isolation witness after an early return", () => {
    const unreachable = REAL_DB_COVERAGE.replace(
      "    await assertIsolationQuery({",
      "    return;\n    await assertIsolationQuery({",
    );
    expect(annotationErrorFor(unreachable)).toMatch(/unreachable after an earlier return/);
  });

  it("rejects an isolation witness after a statically unconditional return", () => {
    const unreachable = REAL_DB_COVERAGE.replace(
      "    await assertIsolationQuery({",
      "    if (true) return;\n    await assertIsolationQuery({",
    );
    expect(annotationErrorFor(unreachable)).toMatch(/unreachable after an earlier return/);
  });

  it.each([
    [
      "comma expression",
      '(db.from("bookings").select("id"), Promise.resolve({ data: [], error: null }))',
    ],
    [
      "logical expression",
      'db.from("bookings").select("id") && Promise.resolve({ data: [], error: null })',
    ],
    [
      ".then transform",
      'db.from("bookings").select("id").then(() => ({ data: [], error: null }))',
    ],
  ])("rejects DB evidence whose result is laundered through a %s", (_shape, queryResult) => {
    const laundered = REAL_DB_COVERAGE.replace('db.from("bookings").select("id")', queryResult);
    expect(annotationErrorFor(laundered)).toMatch(/resource mismatch.*queried none/);
  });

  it("fails loud when an annotation points to a missing integration test", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer("missing test title")}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const result = findMockedTenantTests(F, source, new Map([[RLS_FILE, REAL_DB_COVERAGE]]));
    expect(result).toHaveLength(1);
    expect(result[0]?.annotationError).toMatch(/coverage test not found/);
  });

  it("fails loud when an annotation target mocks the DB client", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const mockedCoverage = `${REAL_DB_COVERAGE}\nvi.mock("@supabase/supabase-js");`;
    const result = findMockedTenantTests(F, source, new Map([[RLS_FILE, mockedCoverage]]));
    expect(result).toHaveLength(1);
    expect(result[0]?.annotationError).toMatch(/coverage target mocks/);
  });

  it("rejects a coverage target that fully mocks Postgres", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const mockedCoverage = `${REAL_DB_COVERAGE}\nvi.mock("postgres");`;
    const result = findMockedTenantTests(F, source, new Map([[RLS_FILE, mockedCoverage]]));
    expect(result[0]?.annotationError).toMatch(/coverage target mocks the Postgres client/);
  });

  it("rejects a partial Supabase mock that replaces createClient", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const mockedCoverage = `${REAL_DB_COVERAGE}\nvi.mock("@supabase/supabase-js", async (importOriginal) => ({ ...(await importOriginal()), createClient: vi.fn() }));`;
    const result = findMockedTenantTests(F, source, new Map([[RLS_FILE, mockedCoverage]]));
    expect(result[0]?.annotationError).toMatch(/coverage target mocks the Supabase client/);
  });

  it.each([
    ['["assert" + "IsolationQuery"]', '["assert" + "IsolationQuery"]'],
    ["an unknown computed key", "[replacementName]"],
  ])("rejects a partial witness mock that replaces the export through %s", (_shape, key) => {
    const mockedCoverage = `${REAL_DB_COVERAGE}\nconst replacementName = "assertIsolationQuery";\nvi.mock("../../../../tests/helpers/isolation-witness", async (importOriginal) => ({ ...(await importOriginal()), ${key}: vi.fn() }));`;
    expect(annotationErrorFor(mockedCoverage)).toMatch(/mocks the canonical isolation witness/);
  });

  it("accepts a partial witness mock with a statically unrelated computed key", () => {
    const mockedCoverage = `${REAL_DB_COVERAGE}\nvi.mock("../../../../tests/helpers/isolation-witness", async (importOriginal) => ({ ...(await importOriginal()), ["helper" + "Fn"]: vi.fn() }));`;
    expect(annotationErrorFor(mockedCoverage)).toBeUndefined();
  });

  it("rejects ordered trailing witness spread overrides", () => {
    const factories = [
      `async (importOriginal) => ({ ...(await importOriginal()), ...runtimeOverrides })`,
      `async (importOriginal) => ({ ...(await importOriginal()), ...getRuntimeOverrides() })`,
      `async (importOriginal) => ({ ...(await importOriginal()), ...{ ...runtimeOverrides } })`,
      `async (importOriginal) => ({ ...(await importOriginal()), ...(process.env.USE_OVERRIDE ? {} : { assertIsolationQuery: vi.fn() }) })`,
      `async (importOriginal) => { const replacements = { assertIsolationQuery: vi.fn() }; return { ...(await importOriginal()), ...replacements }; }`,
    ];
    for (const factory of factories) {
      const mockedCoverage = `${REAL_DB_COVERAGE}\nvi.mock("../../../../tests/helpers/isolation-witness", ${factory});`;
      expect(annotationErrorFor(mockedCoverage)).toMatch(/mocks the canonical isolation witness/);
    }
  });

  it("accepts ordered witness spreads when the protected export finishes original", () => {
    const factories = [
      `async (importOriginal) => ({ ...runtimeOverrides, ...(await importOriginal()) })`,
      `async (importOriginal) => ({ assertIsolationQuery: vi.fn(), ...(await importOriginal()) })`,
      `async (importOriginal) => { const helpers = { helper: vi.fn() }; return { ...(await importOriginal()), ...helpers }; }`,
      `async (importOriginal) => ({ ...(await importOriginal()), ...(process.env.FIRST_SHAPE ? { helper: true } : { other: true }) })`,
      `async (importOriginal) => ({ ...(await importOriginal()), metadata: { assertIsolationQuery: vi.fn() } })`,
    ];
    for (const factory of factories) {
      const mockedCoverage = `${REAL_DB_COVERAGE}\nvi.mock("../../../../tests/helpers/isolation-witness", ${factory});`;
      expect(annotationErrorFor(mockedCoverage)).toBeUndefined();
    }
  });

  it.each([
    [
      "block branches",
      "async (importOriginal) => { if (process.env.PRESERVE_ORIGINAL) return { ...(await importOriginal()) }; return {}; }",
    ],
    [
      "conditional expression branches",
      "async (importOriginal) => process.env.PRESERVE_ORIGINAL ? { ...(await importOriginal()) } : {}",
    ],
  ])("rejects a witness factory when one of its %s drops the original module", (_shape, factory) => {
    const mockedCoverage = `${REAL_DB_COVERAGE}\nvi.mock("../../../../tests/helpers/isolation-witness", ${factory});`;
    expect(annotationErrorFor(mockedCoverage)).toMatch(/mocks the canonical isolation witness/);
  });

  it("accepts a witness factory when every return path preserves the original module", () => {
    const mockedCoverage = `${REAL_DB_COVERAGE}\nvi.mock("../../../../tests/helpers/isolation-witness", async (importOriginal) => { if (process.env.FIRST_SHAPE) return { ...(await importOriginal()), first: true }; return { ...(await importOriginal()), second: true }; });`;
    expect(annotationErrorFor(mockedCoverage)).toBeUndefined();
  });

  it("rejects witness factories whose original loader provenance is mutated", () => {
    for (const [_shape, mutation, callee] of MUTATED_LOADER_FACTORIES) {
      const factory = `async (loader) => { const fake = async () => ({}); ${mutation} return { ...(await ${callee}()) }; }`;
      const mockedCoverage = `${REAL_DB_COVERAGE}\nvi.mock("../../../../tests/helpers/isolation-witness", ${factory});`;
      expect(annotationErrorFor(mockedCoverage)).toMatch(/mocks the canonical isolation witness/);
    }
  });

  it("accepts witness factories with proven restored or immutable loaders", () => {
    for (const [_shape, setup, callee] of PROVEN_LOADER_FACTORIES) {
      const factory = `async (loader) => { const fake = async () => ({}); ${setup} return { ...(await ${callee}()) }; }`;
      const mockedCoverage = `${REAL_DB_COVERAGE}\nvi.mock("../../../../tests/helpers/isolation-witness", ${factory});`;
      expect(annotationErrorFor(mockedCoverage)).toBeUndefined();
    }
  });

  it("rejects witness factories whose loader is mutated through a callable", () => {
    for (const [_shape, invocation] of MUTATOR_CALL_FACTORIES) {
      const factory = `async (loader) => { const fake = async () => ({}); ${invocation} return { ...(await loader()) }; }`;
      const mockedCoverage = `${REAL_DB_COVERAGE}\nvi.mock("../../../../tests/helpers/isolation-witness", ${factory});`;
      expect(annotationErrorFor(mockedCoverage)).toMatch(/mocks the canonical isolation witness/);
    }
  });

  it("accepts witness factories after callables leave the loader proven", () => {
    for (const [_shape, invocation] of SAFE_CALL_FACTORIES) {
      const factory = `async (loader) => { const fake = async () => ({}); ${invocation} return { ...(await loader()) }; }`;
      const mockedCoverage = `${REAL_DB_COVERAGE}\nvi.mock("../../../../tests/helpers/isolation-witness", ${factory});`;
      expect(annotationErrorFor(mockedCoverage)).toBeUndefined();
    }
  });

  it("rejects a partial Postgres mock that replaces the default factory", () => {
    const mockedCoverage = `
import postgres from "postgres";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
const DB_URL = process.env.SUPABASE_DB_URL;
vi.mock("postgres", async (importOriginal) => ({ ...(await importOriginal()), ...{ default: vi.fn() } }));
describe("RLS integration", () => {
  it("bookings: userB cannot SELECT tenantA rows", async () => {
    const sql = postgres(DB_URL!);
    await assertIsolationQuery({
      query: () => sql\`SELECT id FROM public.bookings\`,
      allowedIds: [],
      deniedIds: ["booking-a"],
    });
  });
});
`;
    expect(annotationErrorFor(mockedCoverage)).toMatch(/coverage target mocks the Postgres client/);
  });

  it("rejects a coverage target that mocks the canonical witness", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const mockedCoverage = `${REAL_DB_COVERAGE}\nvi.mock("../../../../tests/helpers/isolation-witness");`;
    const result = findMockedTenantTests(F, source, new Map([[RLS_FILE, mockedCoverage]]));
    expect(result[0]?.annotationError).toMatch(/mocks the canonical isolation witness/);
  });

  it("rejects a coverage target that mocks the imported canonical witness binding", () => {
    const mockedCoverage = REAL_DB_COVERAGE.replace(
      'describe("RLS integration", () => {',
      'vi.mocked(assertIsolationQuery).mockResolvedValue(undefined);\ndescribe("RLS integration", () => {',
    );
    expect(annotationErrorFor(mockedCoverage)).toMatch(/mocks the canonical isolation witness/);
  });

  it.each([
    [
      "function declaration",
      "    async function assertIsolationQuery() {}\n",
    ],
    [
      "const declaration",
      "    const assertIsolationQuery = async () => {};\n",
    ],
  ])("rejects a callback-local %s shadowing the canonical witness", (_shape, declaration) => {
    const shadowed = REAL_DB_COVERAGE.replace(
      '    const db = createClient("https://db.example.test", "anon-key");',
      `${declaration}    const db = createClient("https://db.example.test", "anon-key");`,
    );
    expect(annotationErrorFor(shadowed)).toMatch(/shadows the imported canonical isolation witness/);
  });

  it("rejects a callback parameter shadowing the canonical witness", () => {
    const shadowed = REAL_DB_COVERAGE.replace(
      'it("bookings: userB cannot SELECT tenantA rows", async () => {',
      'it("bookings: userB cannot SELECT tenantA rows", async (assertIsolationQuery = async () => {}) => {',
    );
    expect(annotationErrorFor(shadowed)).toMatch(/shadows the imported canonical isolation witness/);
  });

  it("accepts an aliased canonical witness import and call", () => {
    const aliased = REAL_DB_COVERAGE
      .replace(
        "import { assertIsolationQuery } from",
        "import { assertIsolationQuery as assertScopeIsolation } from",
      )
      .replace("await assertIsolationQuery({", "await assertScopeIsolation({");
    expect(annotationErrorFor(aliased)).toBeUndefined();
  });

  it.each([
    ["const", "  const assertIsolationQuery = async () => {};\n"],
    ["function", "  async function assertIsolationQuery() {}\n"],
    ["class", "  class assertIsolationQuery {}\n"],
  ])("rejects a describe-scope %s shadowing the canonical witness", (_shape, declaration) => {
    const shadowed = REAL_DB_COVERAGE.replace(
      'describe("RLS integration", () => {\n',
      `describe("RLS integration", () => {\n${declaration}`,
    );
    expect(annotationErrorFor(shadowed)).toMatch(/shadows the imported canonical isolation witness/);
  });

  it("rejects an enclosing callback parameter shadowing the canonical witness", () => {
    const shadowed = REAL_DB_COVERAGE.replace(
      'describe("RLS integration", () => {',
      'describe("RLS integration", (assertIsolationQuery = async () => {}) => {',
    );
    expect(annotationErrorFor(shadowed)).toMatch(/shadows the imported canonical isolation witness/);
  });

  it("rejects an enclosing block declaration shadowing the canonical witness", () => {
    const shadowed = REAL_DB_COVERAGE
      .replace(
        '  it("bookings: userB cannot SELECT tenantA rows", async () => {',
        '  {\n    const assertIsolationQuery = async () => {};\n  it("bookings: userB cannot SELECT tenantA rows", async () => {',
      )
      .replace("  });\n});", "  });\n  }\n});");
    expect(annotationErrorFor(shadowed)).toMatch(/shadows the imported canonical isolation witness/);
  });

  it.each([
    [
      "for-of initializer",
      "  for (const assertIsolationQuery of [async () => {}]) {\n",
    ],
    [
      "destructured for-of initializer",
      "  for (const [assertIsolationQuery] of [[async () => {}]]) {\n",
    ],
    [
      "for-in initializer",
      "  for (const assertIsolationQuery in { fake: true }) {\n",
    ],
    [
      "classic for initializer",
      "  for (let assertIsolationQuery = async () => {}, once = true; once; once = false) {\n",
    ],
  ])("rejects a canonical witness shadowed by a %s", (_shape, loopStart) => {
    const shadowed = REAL_DB_COVERAGE
      .replace(
        '  it("bookings: userB cannot SELECT tenantA rows", async () => {',
        `${loopStart}  it("bookings: userB cannot SELECT tenantA rows", async () => {`,
      )
      .replace("  });\n});", "  });\n  }\n});");
    expect(annotationErrorFor(shadowed)).toMatch(/shadows the imported canonical isolation witness/);
  });

  it("rejects a named function-expression binding shadowing the canonical witness", () => {
    const shadowed = REAL_DB_COVERAGE
      .replace(
        '  it("bookings: userB cannot SELECT tenantA rows", async () => {',
        '  (function assertIsolationQuery() {\n  it("bookings: userB cannot SELECT tenantA rows", async () => {',
      )
      .replace("  });\n});", "  });\n  })();\n});");
    expect(annotationErrorFor(shadowed)).toMatch(/shadows the imported canonical isolation witness/);
  });

  it("rejects a named class-expression binding shadowing the canonical witness", () => {
    const shadowed = REAL_DB_COVERAGE
      .replace(
        '  it("bookings: userB cannot SELECT tenantA rows", async () => {',
        '  (class assertIsolationQuery { static register() {\n  it("bookings: userB cannot SELECT tenantA rows", async () => {',
      )
      .replace("  });\n});", "  });\n  }}).register();\n});");
    expect(annotationErrorFor(shadowed)).toMatch(/shadows the imported canonical isolation witness/);
  });

  it.each([
    ["sibling block", "    { var [assertIsolationQuery] = [async () => {}]; }\n"],
    ["sibling if", "    if (false) { var assertIsolationQuery = async () => {}; }\n"],
    ["sibling loop", "    while (false) { var assertIsolationQuery = async () => {}; }\n"],
    ["sibling switch", "    switch (0) { case 1: var assertIsolationQuery = async () => {}; }\n"],
    ["sibling try", "    try { var assertIsolationQuery = async () => {}; } catch {}\n"],
  ])("rejects a function-scoped witness var hoisted from a %s", (_shape, declaration) => {
    const shadowed = REAL_DB_COVERAGE.replace(
      '    const db = createClient("https://db.example.test", "anon-key");',
      `${declaration}    const db = createClient("https://db.example.test", "anon-key");`,
    );
    expect(annotationErrorFor(shadowed)).toMatch(/shadows the imported canonical isolation witness/);
  });

  it.each([
    ["nested function", "    function unrelated() { var assertIsolationQuery = async () => {}; }\n"],
    ["nested class", "    class Unrelated { method() { var assertIsolationQuery = async () => {}; } }\n"],
  ])("does not treat a var inside a %s as shadowing the imported witness", (_shape, declaration) => {
    const legitimate = REAL_DB_COVERAGE.replace(
      '    const db = createClient("https://db.example.test", "anon-key");',
      `${declaration}    const db = createClient("https://db.example.test", "anon-key");`,
    );
    expect(annotationErrorFor(legitimate)).toBeUndefined();
  });

  it("rejects a DB operation without the canonical isolation assertion", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const operationOnly = REAL_DB_COVERAGE.replace(
      /    await assertIsolationQuery\(\{[\s\S]*?    \}\);/,
      '    await db.from("bookings").select("id");',
    );
    const result = findMockedTenantTests(F, source, new Map([[RLS_FILE, operationOnly]]));
    expect(result).toHaveLength(1);
    expect(result[0]?.annotationError).toMatch(/exactly one canonical isolation witness/);
  });

  it("rejects a suffix-only title instead of binding to a longer full title", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer("bookings: userB cannot SELECT tenantA rows")}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const result = findMockedTenantTests(F, source, new Map([[RLS_FILE, REAL_DB_COVERAGE]]));
    expect(result).toHaveLength(1);
    expect(result[0]?.annotationError).toMatch(/coverage test not found/);
  });

  it("rejects duplicate exact full titles", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const duplicate = REAL_DB_COVERAGE.replace("\n});\n", `
  it("bookings: userB cannot SELECT tenantA rows", async () => {
    const db = createClient("https://db.example.test", "anon-key");
    await assertIsolationQuery({
      query: () => db.from("bookings").select("id"),
      allowedIds: [],
      deniedIds: ["booking-a"],
    });
  });
});
`);
    const result = findMockedTenantTests(F, source, new Map([[RLS_FILE, duplicate]]));
    expect(result).toHaveLength(1);
    expect(result[0]?.annotationError).toMatch(/title is ambiguous.*2 matches/);
  });

  it("rejects an isolation witness querying a different resource", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const wrongResource = REAL_DB_COVERAGE.replace('db.from("bookings")', 'db.from("notes")');
    const result = findMockedTenantTests(F, source, new Map([[RLS_FILE, wrongResource]]));
    expect(result).toHaveLength(1);
    expect(result[0]?.annotationError).toMatch(/resource mismatch.*table:public.notes/);
  });

  it("rejects a witness that returns unrelated data after a DB operation", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const unrelatedResult = REAL_DB_COVERAGE.replace(
      'query: () => db.from("bookings").select("id")',
      'query: async () => { await db.from("bookings").select("id"); return []; }',
    );
    const result = findMockedTenantTests(F, source, new Map([[RLS_FILE, unrelatedResult]]));
    expect(result).toHaveLength(1);
    expect(result[0]?.annotationError).toMatch(/resource mismatch.*queried none/);
  });

  it("rejects an isolation witness with no denied IDs", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const noDeniedIds = REAL_DB_COVERAGE.replace('deniedIds: ["booking-a"]', "deniedIds: []");
    const result = findMockedTenantTests(F, source, new Map([[RLS_FILE, noDeniedIds]]));
    expect(result).toHaveLength(1);
    expect(result[0]?.annotationError).toMatch(/deniedIds must be a non-empty array literal/);
  });

  it("does not let a valid pointer annotate the following sibling test", () => {
    const source = `
import { describe, it, vi } from "vitest";
vi.mock("@supabase/supabase-js");
describe("notes route", () => {
  ${pointer()}
  it("enforces tenant isolation on the list query", async () => {});
  it("enforces tenant isolation on the detail query", async () => {});
});
`;
    const result = findMockedTenantTests(F, source, new Map([[RLS_FILE, REAL_DB_COVERAGE]]));
    expect(result).toHaveLength(1);
    expect(result[0]?.fullName).toMatch(/detail query/);
  });

  it.each([
    {
      family: "protected loader",
      shape: "definite restoration",
      rejected: false,
      run: () =>
        findMockedTenantTests(
          F,
          claimTest(
            'vi.mock("@supabase/supabase-js", async (loader) => { const real = loader; loader = async () => ({}); loader = real; return { ...(await loader()) }; });',
          ),
          EMPTY,
        ).length > 0,
    },
    {
      family: "protected loader",
      shape: "destructuring default mutation",
      rejected: true,
      run: () =>
        findMockedTenantTests(
          F,
          claimTest(
            'vi.mock("@supabase/supabase-js", async (loader) => { const fake = async () => ({}); [loader = fake] = [undefined]; return { ...(await loader()) }; });',
          ),
          EMPTY,
        ).length > 0,
    },
    {
      family: "Supabase query",
      shape: "computed real receiver",
      rejected: false,
      run: () =>
        annotationErrorFor(REAL_DB_COVERAGE.replace('db.from("bookings")', 'db["from"]("bookings")')) !==
        undefined,
    },
    {
      family: "Supabase query",
      shape: "conditional client restoration",
      rejected: true,
      run: () =>
        annotationErrorFor(
          REAL_DB_COVERAGE.replace(
            'const db = createClient("https://db.example.test", "anon-key");',
            'const real = createClient("https://db.example.test", "anon-key"); let db = {} as never; if (process.env.RESTORE) db = real;',
          ),
        ) !== undefined,
    },
    {
      family: "Postgres query",
      shape: "parenthesized real tag",
      rejected: false,
      run: () =>
        annotationErrorFor(`
import postgres from "postgres";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
const DB_URL = process.env.SUPABASE_DB_URL;
describe("RLS integration", () => {
  it("bookings: userB cannot SELECT tenantA rows", async () => {
    const sql = postgres(DB_URL!);
    await assertIsolationQuery({ query: () => (sql)\`SELECT id FROM public.bookings\`, allowedIds: [], deniedIds: ["booking-a"] });
  });
});`) !== undefined,
    },
    {
      family: "Postgres query",
      shape: "relation only in SQL comment",
      rejected: true,
      run: () =>
        annotationErrorFor(`
import postgres from "postgres";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
const DB_URL = process.env.SUPABASE_DB_URL;
describe("RLS integration", () => {
  it("bookings: userB cannot SELECT tenantA rows", async () => {
    const sql = postgres(DB_URL!);
    await assertIsolationQuery({ query: () => sql\`SELECT 1 /* FROM public.bookings */\`, allowedIds: [], deniedIds: ["booking-a"] });
  });
});`) !== undefined,
    },
    {
      family: "canonical witness",
      shape: "immutable alias",
      rejected: false,
      run: () =>
        annotationErrorFor(
          REAL_DB_COVERAGE.replace(
            '    const db = createClient("https://db.example.test", "anon-key");',
            '    const db = createClient("https://db.example.test", "anon-key");\n    const witness = assertIsolationQuery;',
          ).replace("await assertIsolationQuery(", "await witness("),
        ) !== undefined,
    },
    {
      family: "canonical witness",
      shape: "early return through try/finally",
      rejected: true,
      run: () =>
        annotationErrorFor(
          REAL_DB_COVERAGE.replace(
            "    await assertIsolationQuery({",
            "    try { return; } finally {}\n    await assertIsolationQuery({",
          ),
        ) !== undefined,
    },
  ])("keeps $family parity for $shape", ({ rejected, run }) => {
    expect(run()).toBe(rejected);
  });
});

describe("loadBaseline", () => {
  it("returns an empty map for a missing file (fail-closed)", () => {
    expect(loadBaseline("/nonexistent/mocked-baseline-2028.txt")).toEqual(new Map());
  });
});

// walk()'s swallowMissing flag: an explicit CLI dir argument is required
// input (fail loud on a typo'd path), but a nested/default dir discovered by
// recursion or defaultDirs() is optional and should skip silently.
describe("walk", () => {
  const missing = path.join(tmpdir(), "mocked-tenant-tests-walk-missing-2038");

  it("throws on a nonexistent dir when swallowMissing=false (explicit CLI arg)", () => {
    expect(() => walk(missing, false)).toThrow(/ENOENT/);
  });

  it("returns [] for a nonexistent dir when swallowMissing=true (default dirs)", () => {
    expect(walk(missing, true)).toEqual([]);
  });

  // main()'s resolutionDirs().flatMap((d) => walk(d)) must wrap walk in an
  // arrow, not pass it bare: Array.flatMap invokes its callback with
  // (element, index, array), so a bare `dirs.flatMap(walk)` silently feeds
  // the array INDEX in as walk's second positional arg (swallowMissing). For
  // a missing dir at index 0, that arg is falsy `0` — walk throws instead of
  // skipping — while the very same missing dir at index 1+ would get a
  // truthy index and skip. Position-dependent behavior on a single missing
  // dir is exactly the arity bug; pin that the actual (arrow-wrapped) call
  // form is immune to it regardless of position.
  it("flatMap(walk) bare (the bug form) breaks on a missing dir at index 0", () => {
    const existing = mkdtempSync(path.join(tmpdir(), "mocked-tenant-tests-walk-ok-"));
    try {
      writeFileSync(path.join(existing, "x.test.ts"), "");
      expect(() => [missing, existing].flatMap(walk)).toThrow(/ENOENT/);
    } finally {
      rmSync(existing, { recursive: true, force: true });
    }
  });

  it("flatMap((d) => walk(d)) (the actual main() call form) skips a missing dir at any position", () => {
    const existing = mkdtempSync(path.join(tmpdir(), "mocked-tenant-tests-walk-ok-"));
    try {
      writeFileSync(path.join(existing, "x.test.ts"), "");
      const filesFirst = [missing, existing].flatMap((d) => walk(d));
      const filesSecond = [existing, missing].flatMap((d) => walk(d));
      expect(filesFirst).toEqual([path.join(existing, "x.test.ts")]);
      expect(filesSecond).toEqual([path.join(existing, "x.test.ts")]);
    } finally {
      rmSync(existing, { recursive: true, force: true });
    }
  });
});

// CLI-level fail-loud behavior of main() — exercised via a real subprocess
// since main() reads process.argv / calls process.exit directly.
describe("main() CLI", () => {
  it("exits 1 when an explicit dir arg yields zero matching files", () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "mocked-tenant-tests-empty-"));
    try {
      execFileSync(TSX, [SCRIPT, emptyDir], { stdio: "pipe" });
      expect.fail("expected the CLI to exit non-zero");
    } catch (err) {
      const e = err as { status: number | null; stderr: Buffer };
      expect(e.status).toBe(1);
      expect(e.stderr.toString()).toMatch(/zero files/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("exits 1 with ENOENT when an explicit dir arg doesn't exist", () => {
    const missingDir = path.join(tmpdir(), "mocked-tenant-tests-cli-missing-2038");
    try {
      execFileSync(TSX, [SCRIPT, missingDir], { stdio: "pipe" });
      expect.fail("expected the CLI to exit non-zero");
    } catch (err) {
      const e = err as { status: number | null };
      expect(e.status).not.toBe(0);
    }
  });
});
