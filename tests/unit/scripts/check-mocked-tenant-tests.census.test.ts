import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  derivePostgresMigrationProvenance,
  findMockedTenantTests,
  postgresResourcesMatchReviewedProvenance,
  type PostgresProvenanceTarget,
} from "../../../scripts/check-mocked-tenant-tests";

const UNIT = "apps/main/test/unit/probe.test.ts";
const TARGET = "apps/main/test/integration/probe.test.ts";
const TITLE = "RLS integration bookings: userB cannot SELECT tenantA rows";
const POINTER = `// @rls-covered-by resources=table:public.bookings target=${TARGET}#${TITLE}`;

type Result = { family: string; shape: string; intent: "unsafe" | "safe"; verdict: string; detail?: string };
const rows: Result[] = [];
const regressions: Result[] = [];

function unit(mock: string, pointer = false): string {
  return `import { describe, it, vi } from "vitest";\n${mock}\ndescribe("notes", () => {\n${pointer ? `  ${POINTER}\n` : ""}  it("enforces tenant isolation", async () => {});\n});\n`;
}

function resultFor(family: string, shape: string, intent: "unsafe" | "safe", source: string, target?: string): Result {
  const byPath = target === undefined ? new Map<string, string>() : new Map([[TARGET, target]]);
  const finding = findMockedTenantTests(UNIT, source, byPath)[0];
  return {
    family,
    shape,
    intent,
    verdict: finding ? "REJECT" : "ACCEPT",
    ...(finding?.annotationError ? { detail: finding.annotationError } : {}),
  };
}

function observe(family: string, shape: string, intent: "unsafe" | "safe", source: string, target?: string): void {
  rows.push(resultFor(family, shape, intent, source, target));
}

for (const specifier of ["@supabase/supabase-js", "postgres"]) {
  const loader = (body: string) => unit(`vi.mock("${specifier}", async (loader) => { const fake = async () => ({}); ${body} return { ...(await loader()) }; });`);
  observe(`loader:${specifier}`, "direct overwrite", "unsafe", loader("loader = fake;"));
  observe(`loader:${specifier}`, "definite restore", "safe", loader("const real = loader; loader = fake; loader = real;"));
  observe(`loader:${specifier}`, "destructuring default write", "unsafe", loader("[loader = fake] = [undefined];"));
  observe(`loader:${specifier}`, "block var aliases parameter", "unsafe", loader("if (process.env.X) { var loader = fake; }"));
  observe(`loader:${specifier}`, "bound mutator call", "unsafe", loader("const mutate = () => { loader = fake; }; mutate.bind(null)();"));
  observe(`loader:${specifier}`, "constructor mutator", "unsafe", loader("new (function () { loader = fake; })();"));
  observe(`loader:${specifier}`, "callback nested in object", "unsafe", loader("const runNow = (x: { callback: () => void }) => x.callback(); runNow({ callback: () => { loader = fake; } });"));
  observe(`loader:${specifier}`, "direct call mutator", "unsafe", loader("const mutate = () => { loader = fake; }; mutate.call(null);"));
  observe(`loader:${specifier}`, "optional original call", "safe", unit(`vi.mock("${specifier}", async (loader) => ({ ...(await loader?.()) }));`));
  observe(`loader:${specifier}`, "generator invocation without next", "safe", loader("function* mutate() { loader = fake; } mutate();"));
  observe(`loader:${specifier}`, "eval mutation", "unsafe", loader('eval("loader = fake");'));
  observe(`loader:${specifier}`, "for-of assignment target", "unsafe", loader("for (loader of [fake]) {}"));
  observe(
    `loader:${specifier}`,
    "overwritten own call member",
    "unsafe",
    unit(`vi.mock("${specifier}", async (loader) => { const fake = async () => ({}); loader.call = fake; return { ...(await loader.call(null)) }; });`),
  );
}

function supabaseTarget(setup: string, query = 'db.from("bookings").select("id")', witnessSetup = ""): string {
  return `
import { createClient } from "@supabase/supabase-js";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
import { vi } from "vitest";
const DB_URL = process.env.SUPABASE_DB_URL;
describe("RLS integration", () => {
  it("bookings: userB cannot SELECT tenantA rows", async () => {
    const fake = { from: () => ({ select: async () => ({ data: [], error: null }) }) } as never;
    ${setup}
    ${witnessSetup}
    await assertIsolationQuery({ query: () => ${query}, allowedIds: [], deniedIds: ["booking-a"] });
  });
});`;
}

function postgresTarget(setup: string, query = 'sql`SELECT id FROM public.bookings`', witnessSetup = ""): string {
  return `
import postgres from "postgres";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
import { vi } from "vitest";
const DB_URL = process.env.SUPABASE_DB_URL;
describe("RLS integration", () => {
  it("bookings: userB cannot SELECT tenantA rows", async () => {
    const fake = (() => Promise.resolve([])) as never;
    ${setup}
    ${witnessSetup}
    await assertIsolationQuery({ query: () => ${query}, allowedIds: [], deniedIds: ["booking-a"] });
  });
});`;
}

const pointerUnit = unit('vi.mock("@supabase/supabase-js");', true);
observe("supabase", "direct client overwrite", "unsafe", pointerUnit, supabaseTarget("let db = createClient(DB_URL!, \"key\"); db = fake;"));
observe("supabase", "definite client restore", "safe", pointerUnit, supabaseTarget("let db = createClient(DB_URL!, \"key\"); const real = db; db = fake; db = real;"));
observe("supabase", "conditional restore join", "unsafe", pointerUnit, supabaseTarget("const real = createClient(DB_URL!, \"key\"); let db = fake; if (process.env.X) db = real;"));
observe("supabase", "destructuring default write", "unsafe", pointerUnit, supabaseTarget("let db = createClient(DB_URL!, \"key\"); [db = fake] = [undefined];"));
observe("supabase", "block var aliases outer var", "unsafe", pointerUnit, supabaseTarget("var db = createClient(DB_URL!, \"key\"); if (process.env.X) { var db = fake; }"));
observe("supabase", "overwritten helper function", "unsafe", pointerUnit, supabaseTarget("let make = () => createClient(DB_URL!, \"key\"); make = () => fake; const db = make();"));
observe("supabase", "destructured vi.mocked factory", "unsafe", pointerUnit, supabaseTarget("const { mocked } = vi; mocked(createClient).mockImplementation(() => fake); const db = createClient(DB_URL!, \"key\");"));
observe("supabase", "direct receiver assignment", "unsafe", pointerUnit, supabaseTarget("const db = createClient(DB_URL!, \"key\"); db.from = fake.from;"));
observe("supabase", "logical receiver assignment", "unsafe", pointerUnit, supabaseTarget("const db = createClient(DB_URL!, \"key\"); db.from ||= fake.from;"));
observe("supabase", "logical AND receiver assignment", "unsafe", pointerUnit, supabaseTarget("const db = createClient(DB_URL!, \"key\"); db.from &&= fake.from;"));
observe("supabase", "dynamic Object.assign receiver", "unsafe", pointerUnit, supabaseTarget("const db = createClient(DB_URL!, \"key\"); const override = { from: fake.from }; Object.assign(db, override);"));
observe("supabase", "Object.assign getter receiver", "unsafe", pointerUnit, supabaseTarget("const db = createClient(DB_URL!, \"key\"); Object.assign(db, { get from() { return fake.from; } });"));
observe("supabase", "Object.defineProperties receiver", "unsafe", pointerUnit, supabaseTarget("const db = createClient(DB_URL!, \"key\"); Object.defineProperties(db, { from: { value: fake.from } });"));
observe("supabase", "Reflect.defineProperty receiver", "unsafe", pointerUnit, supabaseTarget("const db = createClient(DB_URL!, \"key\"); Reflect.defineProperty(db, \"from\", { value: fake.from });"));
observe("supabase", "destructured spyOn receiver", "unsafe", pointerUnit, supabaseTarget("const db = createClient(DB_URL!, \"key\"); const { spyOn } = vi; spyOn(db, \"from\").mockImplementation(fake.from);"));
observe("supabase", "computed from call", "safe", pointerUnit, supabaseTarget("const db = createClient(DB_URL!, \"key\");", 'db["from"]("bookings").select("id")'));
observe("supabase", "optional direct chain", "safe", pointerUnit, supabaseTarget("const db = createClient(DB_URL!, \"key\");", 'db?.from("bookings")?.select("id")'));

for (const [shape, restore] of [
  ["conditional expression join", "process.env.X ? db = real : 0;"],
  ["logical expression join", "process.env.X && (db = real);"],
  ["switch join", 'switch (process.env.X) { case "yes": db = real; }'],
  ["zero-iteration loop join", "while (process.env.X) { db = real; break; }"],
  ["try join", "try { if (process.env.X) db = real; } catch {}"],
] as const) {
  observe("supabase-flow", shape, "unsafe", pointerUnit, supabaseTarget(`const real = createClient(DB_URL!, "key"); let db = fake; ${restore}`));
}
observe("supabase-flow", "for-of assignment target", "unsafe", pointerUnit, supabaseTarget("let db = createClient(DB_URL!, \"key\"); for (db of [fake]) {}"));
observe(
  "supabase-flow",
  "write after query closure creation",
  "unsafe",
  pointerUnit,
  supabaseTarget("let db = createClient(DB_URL!, \"key\");").replace('["booking-a"]', '[(db = fake, "booking-a")]'),
);

observe("postgres", "direct client overwrite", "unsafe", pointerUnit, postgresTarget("let sql = postgres(DB_URL!); sql = fake;"));
observe("postgres", "definite client restore", "safe", pointerUnit, postgresTarget("let sql = postgres(DB_URL!); const real = sql; sql = fake; sql = real;"));
observe("postgres", "conditional restore join", "unsafe", pointerUnit, postgresTarget("const real = postgres(DB_URL!); let sql = fake; if (process.env.X) sql = real;"));
observe("postgres", "destructuring default write", "unsafe", pointerUnit, postgresTarget("let sql = postgres(DB_URL!); [sql = fake] = [undefined];"));
observe("postgres", "block var aliases outer var", "unsafe", pointerUnit, postgresTarget("var sql = postgres(DB_URL!); if (process.env.X) { var sql = fake; }"));
observe("postgres", "direct vi.mocked factory", "unsafe", pointerUnit, postgresTarget("vi.mocked(postgres).mockImplementation(() => fake); const sql = postgres(DB_URL!);"));
observe("postgres", "direct mocked receiver", "unsafe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!); vi.mocked(sql).mockImplementation(fake);"));
observe("postgres", "destructured mocked receiver", "unsafe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!); const { mocked } = vi; mocked(sql).mockImplementation(fake);"));
observe("postgres", "parenthesized tag", "safe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", '(sql)`SELECT id FROM public.bookings`'));
observe("postgres", "relation text only in SQL comment", "unsafe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT 1 /* FROM public.bookings */`"));
observe("postgres", "relation text only in SQL string", "unsafe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT 'FROM public.bookings' AS note WHERE false`"));

for (const [shape, restore] of [
  ["conditional expression join", "process.env.X ? sql = real : 0;"],
  ["logical expression join", "process.env.X && (sql = real);"],
  ["switch join", 'switch (process.env.X) { case "yes": sql = real; }'],
  ["zero-iteration loop join", "while (process.env.X) { sql = real; break; }"],
  ["try join", "try { if (process.env.X) sql = real; } catch {}"],
] as const) {
  observe("postgres-flow", shape, "unsafe", pointerUnit, postgresTarget(`const real = postgres(DB_URL!); let sql = fake; ${restore}`));
}
observe("postgres-flow", "for-of assignment target", "unsafe", pointerUnit, postgresTarget("let sql = postgres(DB_URL!); for (sql of [fake]) {}"));
observe(
  "postgres-flow",
  "write after query closure creation",
  "unsafe",
  pointerUnit,
  postgresTarget("let sql = postgres(DB_URL!);").replace('["booking-a"]', '[(sql = fake, "booking-a")]'),
);

const supabaseCatchShadow = `
import { createClient } from "@supabase/supabase-js";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
const DB_URL = process.env.SUPABASE_DB_URL;
const db = createClient(DB_URL!, "key");
const fake = { from: () => ({ select: async () => ({ data: [], error: null }) }) } as never;
try { throw fake; } catch (db) {
  describe("RLS integration", () => {
    it("bookings: userB cannot SELECT tenantA rows", async () => {
      await assertIsolationQuery({ query: () => db.from("bookings").select("id"), allowedIds: [], deniedIds: ["booking-a"] });
    });
  });
}`;
observe("supabase-flow", "catch binding shadows proven client", "unsafe", pointerUnit, supabaseCatchShadow);

const supabaseNamedFunctionShadow = `
import { createClient } from "@supabase/supabase-js";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
const DB_URL = process.env.SUPABASE_DB_URL;
const db = createClient(DB_URL!, "key");
const fakeFrom = () => ({ select: async () => ({ data: [], error: null }) });
const register = Object.assign(function db() {
  describe("RLS integration", () => {
    it("bookings: userB cannot SELECT tenantA rows", async () => {
      await assertIsolationQuery({ query: () => db.from("bookings").select("id"), allowedIds: [], deniedIds: ["booking-a"] });
    });
  });
}, { from: fakeFrom });
register();`;
observe("supabase-flow", "named function-expression shadows proven client", "unsafe", pointerUnit, supabaseNamedFunctionShadow);

const postgresCatchShadow = `
import postgres from "postgres";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
const DB_URL = process.env.SUPABASE_DB_URL;
const sql = postgres(DB_URL!);
const fake = (() => Promise.resolve([])) as never;
try { throw fake; } catch (sql) {
  describe("RLS integration", () => {
    it("bookings: userB cannot SELECT tenantA rows", async () => {
      await assertIsolationQuery({ query: () => sql\`SELECT id FROM public.bookings\`, allowedIds: [], deniedIds: ["booking-a"] });
    });
  });
}`;
observe("postgres-flow", "catch binding shadows proven client", "unsafe", pointerUnit, postgresCatchShadow);

observe("witness", "direct vi.mocked binding", "unsafe", pointerUnit, supabaseTarget("const db = createClient(DB_URL!, \"key\");", undefined, "vi.mocked(assertIsolationQuery).mockResolvedValue(undefined);"));
observe("witness", "destructured vi.mocked binding", "unsafe", pointerUnit, supabaseTarget("const db = createClient(DB_URL!, \"key\");", undefined, "const { mocked } = vi; mocked(assertIsolationQuery).mockResolvedValue(undefined);"));
observe("witness", "optional direct call", "safe", pointerUnit, supabaseTarget("const db = createClient(DB_URL!, \"key\");").replace("await assertIsolationQuery(", "await assertIsolationQuery?.("));
observe("witness", "variable alias call", "safe", pointerUnit, supabaseTarget("const db = createClient(DB_URL!, \"key\");", undefined, "const witness = assertIsolationQuery;").replace("await assertIsolationQuery(", "await witness("));

for (const [shape, exit] of [
  ["try-finally early return", "try { return; } finally {}"],
  ["switch early return", "switch (1) { case 1: return; }"],
  ["infinite loop early return", "for (;;) { return; }"],
  ["while early return", "while (true) { return; }"],
] as const) {
  observe(
    "witness-reachability",
    shape,
    "unsafe",
    pointerUnit,
    supabaseTarget("const db = createClient(DB_URL!, \"key\");").replace(
      "    await assertIsolationQuery({",
      `    ${exit}\n    await assertIsolationQuery({`,
    ),
  );
}
observe(
  "witness-reachability",
  "literal if early return control",
  "unsafe",
  pointerUnit,
  supabaseTarget("const db = createClient(DB_URL!, \"key\");").replace(
    "    await assertIsolationQuery({",
    "    if (true) return;\n    await assertIsolationQuery({",
  ),
);

const witnessLoaderTarget = supabaseTarget("const db = createClient(DB_URL!, \"key\");").replace(
  'import { vi } from "vitest";',
  'import { vi } from "vitest";\nvi.mock("../../../../tests/helpers/isolation-witness", async (loader) => { const fake = async () => ({}); [loader = fake] = [undefined]; return { ...(await loader()) }; });',
);
observe("witness-loader", "destructuring default write", "unsafe", pointerUnit, witnessLoaderTarget);

function registrationTarget(testRegistration = "it", suiteRegistration = "describe"): string {
  return supabaseTarget("const db = createClient(DB_URL!, \"key\");")
    .replace('describe("RLS integration", () => {', `${suiteRegistration}("RLS integration", () => {`)
    .replace('it("bookings: userB cannot SELECT tenantA rows", async () => {', `${testRegistration}("bookings: userB cannot SELECT tenantA rows", async () => {`);
}

for (const [shape, registration, intent] of [
  ["plain it", "it", "safe"],
  ["test alias", "test", "safe"],
  ["concurrent", "it.concurrent", "safe"],
  ["sequential", "it.sequential", "safe"],
  ["only", "it.only", "safe"],
  ["skip", "it.skip", "unsafe"],
  ["todo", "it.todo", "unsafe"],
  ["fixme", "it.fixme", "unsafe"],
  ["fails", "it.fails", "unsafe"],
  ["skipIf false", "it.skipIf(false)", "safe"],
  ["skipIf true", "it.skipIf(true)", "unsafe"],
  ["skipIf unknown", "it.skipIf(process.env.SKIP_RLS)", "unsafe"],
  ["runIf true", "it.runIf(true)", "safe"],
  ["runIf false", "it.runIf(false)", "unsafe"],
  ["runIf unknown", "it.runIf(process.env.RUN_RLS)", "unsafe"],
  ["each nonempty", "it.each([[1]])", "safe"],
  ["each empty", "it.each([])", "unsafe"],
  ["each spread maybe empty", "it.each([...(process.env.RUN_RLS ? [[1]] : [])])", "unsafe"],
  ["for empty", "it.for([])", "unsafe"],
  ["chained enabled modifier", "it.skipIf(false).concurrent", "safe"],
] as const) {
  observe("registration:test", shape, intent, pointerUnit, registrationTarget(registration));
}

for (const [shape, registration, intent] of [
  ["plain suite", "describe", "safe"],
  ["concurrent suite", "describe.concurrent", "safe"],
  ["skip suite", "describe.skip", "unsafe"],
  ["todo suite", "describe.todo", "unsafe"],
  ["skipIf false suite", "describe.skipIf(false)", "safe"],
  ["skipIf true suite", "describe.skipIf(true)", "unsafe"],
  ["skipIf unknown suite", "describe.skipIf(process.env.SKIP_RLS)", "unsafe"],
  ["runIf true suite", "describe.runIf(true)", "safe"],
  ["runIf false suite", "describe.runIf(false)", "unsafe"],
  ["runIf unknown suite", "describe.runIf(process.env.RUN_RLS)", "unsafe"],
  ["each nonempty suite", "describe.each([[1]])", "safe"],
  ["each empty suite", "describe.each([])", "unsafe"],
  ["each spread maybe empty suite", "describe.each([...(process.env.RUN_RLS ? [[1]] : [])])", "unsafe"],
  ["for empty suite", "describe.for([])", "unsafe"],
] as const) {
  observe("registration:suite", shape, intent, pointerUnit, registrationTarget("it", registration));
}

const testOptions = (options: string) => registrationTarget().replace(
  'it("bookings: userB cannot SELECT tenantA rows", async () => {',
  `it("bookings: userB cannot SELECT tenantA rows", ${options}, async () => {`,
);
for (const [shape, options, intent] of [
  ["options skip false", "{ skip: false }", "safe"],
  ["options skip true", "{ skip: true }", "unsafe"],
  ["options skip unknown", "{ skip: !!process.env.SKIP_RLS }", "unsafe"],
  ["options todo true", "{ todo: true }", "unsafe"],
  ["options fails true", "{ fails: true }", "unsafe"],
] as const) {
  observe("registration:test-options", shape, intent, pointerUnit, testOptions(options));
}

const suiteOptions = (options: string) => registrationTarget().replace(
  'describe("RLS integration", () => {',
  `describe("RLS integration", ${options}, () => {`,
);
for (const [shape, options, intent] of [
  ["suite options skip false", "{ skip: false }", "safe"],
  ["suite options skip true", "{ skip: true }", "unsafe"],
  ["suite options skip unknown", "{ skip: !!process.env.SKIP_RLS }", "unsafe"],
  ["suite options todo true", "{ todo: true }", "unsafe"],
] as const) {
  observe("registration:suite-options", shape, intent, pointerUnit, suiteOptions(options));
}

for (const [shape, mockCall] of [
  ["destructured vi.mock", 'const { mock } = vi; mock("@supabase/supabase-js");'],
  ["aliased vi.doMock", 'const doMock = vi.doMock; doMock("@supabase/supabase-js");'],
  ["computed vi mock", 'vi["mock"]("@supabase/supabase-js");'],
  ["optional vi mock", 'vi.mock?.("@supabase/supabase-js");'],
  ["typed dynamic import mock", 'vi.mock(import("@supabase/supabase-js"));'],
  ["destructured jest.mock", 'const { mock } = jest; mock("@supabase/supabase-js");'],
] as const) {
  observe("mock-call-identity", shape, "unsafe", unit(mockCall));
}

for (const [shape, registration] of [
  ["imported it alias", 'import { it as check } from "vitest"; check("enforces tenant isolation", async () => {});'],
  ["runtime it alias", 'const check = it; check("enforces tenant isolation", async () => {});'],
  ["destructured test alias", 'const { test: check } = vitest; check("enforces tenant isolation", async () => {});'],
  ["computed test member", 'vitest["test"]("enforces tenant isolation", async () => {});'],
  ["conditional skip alias", 'const check = process.env.SKIP_RLS ? it.skip : it; check("enforces tenant isolation", async () => {});'],
] as const) {
  observe("registration-identity:unit", shape, "unsafe", `import { vi, it, vitest } from "vitest"; vi.mock("@supabase/supabase-js"); ${registration}`);
}

const fakeItTarget = registrationTarget().replace(
  'it("bookings: userB cannot SELECT tenantA rows", async () => {',
  'const it = (_name: string, _callback: () => void) => {}; it("bookings: userB cannot SELECT tenantA rows", async () => {',
);
observe("registration-identity:target", "textual fake it registration", "unsafe", pointerUnit, fakeItTarget);
const fakeDescribeTarget = registrationTarget().replace(
  'describe("RLS integration", () => {',
  'const describe = (_name: string, _callback: () => void) => {}; describe("RLS integration", () => {',
);
observe("registration-identity:target", "textual fake describe registration", "unsafe", pointerUnit, fakeDescribeTarget);

function regress(family: string, shape: string, intent: "unsafe" | "safe", source: string, target?: string): void {
  regressions.push(resultFor(family, shape, intent, source, target));
}

const supabaseLoader = (body: string) =>
  unit(`vi.mock("@supabase/supabase-js", async (loader) => { const fake = async () => ({}); ${body} return { ...(await loader()) }; });`);

regress("effects:tag", "local tag mutates loader", "unsafe", supabaseLoader("const tag = () => { loader = fake; }; tag`x`;"));
regress("effects:tag", "local no-op tag", "safe", supabaseLoader("const tag = () => {}; tag`x`;"));
regress("effects:class", "named constructor mutates loader", "unsafe", supabaseLoader("class Mutator { constructor() { loader = fake; } } new Mutator();"));
regress("effects:class", "named no-op constructor", "safe", supabaseLoader("class Noop { constructor() {} } new Noop();"));
regress("effects:generator", "advanced generator mutates loader", "unsafe", supabaseLoader("function* mutate() { loader = fake; } mutate().next();"));
regress("effects:generator", "unadvanced generator", "safe", supabaseLoader("function* mutate() { loader = fake; } mutate();"));
regress("effects:nested-callback", "unknown runner receives mutator object", "unsafe", supabaseLoader("unknownRunner({ callback: () => { loader = fake; } });"));
regress("effects:nested-callback", "unknown runner receives no-op object", "safe", supabaseLoader("unknownRunner({ callback: () => {} });"));
regress("effects:loop", "second for-of element mutates loader", "unsafe", supabaseLoader("const noop = () => {}; const mutate = () => { loader = fake; }; for (const run of [noop, mutate]) run();"));
regress("effects:loop", "all for-of elements are no-ops", "safe", supabaseLoader("const noop = () => {}; for (const run of [noop, noop]) run();"));

regress("aliases:mock", "assigned vi.mock", "unsafe", unit('let mock; mock = vi.mock; mock("@supabase/supabase-js");'));
regress("aliases:mock", "assigned then overwritten mock", "safe", unit('let mock; mock = vi.mock; mock = () => {}; mock("@supabase/supabase-js");'));
regress("aliases:mock", "destructuring-assigned vi.mock", "unsafe", unit('let mock; ({ mock } = vi); mock("@supabase/supabase-js");'));
regress("aliases:mock", "destructuring assignment overwritten", "safe", unit('let mock; ({ mock } = vi); mock = () => {}; mock("@supabase/supabase-js");'));

const assignedRegistrationTarget = (assignment: string) => registrationTarget("register").replace(
  'describe("RLS integration", () => {',
  `let register; ${assignment}\ndescribe("RLS integration", () => {`,
).replace('import { vi } from "vitest";', 'import { vi, vitest } from "vitest";');
regress("aliases:registration", "assigned it target", "safe", pointerUnit, assignedRegistrationTarget("register = it;"));
regress("aliases:registration", "assigned it overwritten by no-op", "unsafe", pointerUnit, assignedRegistrationTarget("register = it; register = () => {};"));
regress("aliases:registration", "destructuring-assigned it target", "safe", pointerUnit, assignedRegistrationTarget("({ it: register } = vitest);"));
regress("registration:alternatives", "framework or no-op target", "unsafe", pointerUnit, assignedRegistrationTarget("register = process.env.X ? it : () => {};"));
regress("registration:alternatives", "two framework targets", "safe", pointerUnit, assignedRegistrationTarget("register = process.env.X ? it : test;"));

regress(
  "witness:class",
  "constructor executes second unawaited witness",
  "unsafe",
  pointerUnit,
  supabaseTarget("const db = createClient(DB_URL!, \"key\");", undefined, "class Extra { constructor() { assertIsolationQuery({ query: () => db.from(\"bookings\").select(\"id\"), allowedIds: [], deniedIds: [\"booking-a\"] }); } } new Extra();"),
);
const wideningBranches = ["A", "B", "C", "D", "E", "F"].map((key) => `if (process.env.${key}) {}`).join(" ");
regress(
  "witness:widening",
  "optional witness across 128 paths",
  "unsafe",
  pointerUnit,
  supabaseTarget("const db = createClient(DB_URL!, \"key\");").replace(
    "    await assertIsolationQuery({",
    `    ${wideningBranches} if (process.env.G) await assertIsolationQuery({`,
  ),
);
regress(
  "witness:widening",
  "identical branches before mandatory witness",
  "safe",
  pointerUnit,
  supabaseTarget("const db = createClient(DB_URL!, \"key\");").replace(
    "    await assertIsolationQuery({",
    `    ${wideningBranches} if (process.env.G) {}\n    await assertIsolationQuery({`,
  ),
);
regress(
  "client:tag",
  "local tag mutates proven client",
  "unsafe",
  pointerUnit,
  supabaseTarget("const db = createClient(DB_URL!, \"key\"); const tag = () => { db.from = fake.from; }; tag`x`;"),
);
regress(
  "client:class",
  "constructor mutates proven client",
  "unsafe",
  pointerUnit,
  supabaseTarget("const db = createClient(DB_URL!, \"key\"); class Mutator { constructor() { db.from = fake.from; } } new Mutator();"),
);

regress("sql:cte", "CTE alias cannot spoof physical table", "unsafe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`WITH bookings AS (SELECT 1 AS id) SELECT id FROM bookings`"));
regress("sql:cte", "schema-qualified physical table", "safe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT id FROM public.bookings`"));
regress("sql:cte", "physical table inside CTE", "safe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`WITH visible AS (SELECT id FROM public.bookings) SELECT id FROM visible`"));

regress("sql:read-only", "DELETE RETURNING is not a proof query", "unsafe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`DELETE FROM public.bookings RETURNING id`"));
regress("sql:read-only", "UPDATE RETURNING is not a proof query", "unsafe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`UPDATE public.bookings SET status = 'x' RETURNING id`"));
regress("sql:read-only", "INSERT RETURNING is not a proof query", "unsafe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`INSERT INTO public.bookings (id) VALUES ('x') RETURNING id`"));
regress("sql:read-only", "MERGE is not a proof query", "unsafe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`MERGE INTO public.bookings USING public.contacts ON false WHEN NOT MATCHED THEN INSERT DEFAULT VALUES RETURNING id`"));
regress("sql:read-only", "CALL is not a proof query", "unsafe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`CALL public.bookings()`"));
regress("sql:read-only", "data-modifying CTE is not a proof query", "unsafe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`WITH changed AS (DELETE FROM public.bookings RETURNING id) SELECT id FROM changed`"));
regress("sql:read-only", "read followed by destructive statement", "unsafe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT id FROM public.bookings; DELETE FROM public.bookings`"));
regress("sql:read-only", "plain SELECT remains a proof query", "safe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT id FROM public.bookings`"));
regress("sql:read-only", "SELECT with trailing semicolon", "safe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT id FROM public.bookings;`"));
regress("sql:read-only", "read-only SELECT CTE remains a proof query", "safe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`WITH visible AS (SELECT id FROM public.bookings) SELECT id FROM visible`"));
regress(
  "sql:function-effects",
  "schema-qualified mutator in SELECT list",
  "unsafe",
  pointerUnit,
  postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT id, public.increment_customer_chat_count(id, id, 30) FROM public.bookings`"),
);
regress(
  "sql:function-effects",
  "repository mutator in nested scalar expression",
  "unsafe",
  pointerUnit,
  postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT id, (SELECT public.increment_weather_usage()) FROM public.bookings`"),
);
regress(
  "sql:function-effects",
  "schema-qualified mutator in read CTE",
  "unsafe",
  pointerUnit,
  postgresTarget("const sql = postgres(DB_URL!);", "sql`WITH effect AS MATERIALIZED (SELECT public.increment_customer_chat_count(id, id, 30) FROM public.bookings) SELECT id FROM public.bookings`"),
);
regress(
  "sql:function-effects",
  "effectful builtins in SELECT list",
  "unsafe",
  pointerUnit,
  postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT id, nextval('booking_sequence'), set_config('app.tenant_id', 'other', false), pg_advisory_lock(42) FROM public.bookings`"),
);
regress(
  "sql:function-effects",
  "mutating function as matching RPC resource",
  "unsafe",
  pointerUnit.replace("resources=table:public.bookings", "resources=rpc:public.increment_customer_chat_count"),
  postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT * FROM public.increment_customer_chat_count(NULL, NULL, 30)`"),
);
regress(
  "sql:function-effects",
  "unknown unqualified function in SELECT list",
  "unsafe",
  pointerUnit,
  postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT id, unknown_effect(id) FROM public.bookings`"),
);
regress(
  "sql:function-effects",
  "verified read-only RPC remains a proof query",
  "safe",
  pointerUnit.replace("resources=table:public.bookings", "resources=rpc:public.match_region_itinerary_chunks"),
  postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT related_chunk_id AS id FROM public.match_region_itinerary_chunks(ARRAY[]::text[], ARRAY[]::text[], CURRENT_DATE, CURRENT_DATE)`"),
);
for (const [shape, statement, resource] of [
  ["unreviewed operator", "SELECT id + id AS id FROM public.bookings", "table:public.bookings"],
  ["unreviewed JSON operator", "SELECT id FROM public.bookings WHERE metadata @> '{}'", "table:public.bookings"],
  ["unreviewed cast", "SELECT id::public.effectful_id AS id FROM public.bookings", "table:public.bookings"],
  ["materialized view", "SELECT tenant_id AS id FROM public.attribution_rollup", "table:public.attribution_rollup"],
  ["unproven foreign relation", "SELECT id FROM public.remote_bookings", "table:public.remote_bookings"],
  ["relation with unreviewed policy code", "SELECT id FROM public.policy_effect_rows", "table:public.policy_effect_rows"],
  ["safe-RPC name with wrong overload", "SELECT related_chunk_id AS id FROM public.match_region_itinerary_chunks()", "rpc:public.match_region_itinerary_chunks"],
  ["catalog sampling method", "SELECT id FROM public.bookings TABLESAMPLE SYSTEM (10)", "table:public.bookings"],
  ["SQL/XML expression", "SELECT XMLPARSE(DOCUMENT '<booking/>') AS id FROM public.bookings", "table:public.bookings"],
  ["SQL/JSON expression", "SELECT JSON_OBJECT('id' VALUE id) AS id FROM public.bookings", "table:public.bookings"],
] as const) {
  regress(
    "sql:executable-provenance",
    shape,
    "unsafe",
    pointerUnit.replace("resources=table:public.bookings", `resources=${resource}`),
    postgresTarget("const sql = postgres(DB_URL!);", `sql\`${statement}\``),
  );
}
for (const [shape, query, setup] of [
  ["unreviewed operator before proof", 'async () => { await sql`SELECT id + id AS id FROM public.bookings`; return sql`SELECT id FROM public.bookings`; }', ""],
  ["saved proof then unreviewed view", 'async () => { const selected = sql`SELECT id FROM public.bookings`; await sql`SELECT tenant_id AS id FROM public.attribution_rollup`; return selected; }', ""],
  ["branch-only unreviewed cast", 'async () => { if (process.env.EFFECT) await sql`SELECT id::public.effectful_id AS id FROM public.bookings`; return sql`SELECT id FROM public.bookings`; }', ""],
  ["aliased helper for unreviewed policy", 'async () => { await readEffect(); return sql`SELECT id FROM public.bookings`; }', 'const query = sql; const readEffect = () => query`SELECT id FROM public.policy_effect_rows`;'],
  ["Promise.all sampling query", 'async () => { await Promise.all([sql`SELECT id FROM public.bookings TABLESAMPLE SYSTEM (10)`, sql`SELECT id FROM public.bookings`]); return sql`SELECT id FROM public.bookings`; }', ""],
] as const) {
  regress(
    "sql:provenance-laundering",
    shape,
    "unsafe",
    pointerUnit,
    postgresTarget(`const sql = postgres(DB_URL!); ${setup}`, query),
  );
}
for (const statement of [
  "VALUES (1)",
  "SHOW search_path",
  "TABLE public.bookings",
  "EXPLAIN SELECT id FROM public.bookings",
] as const) {
  regress(
    "sql:unsupported-read-grammar",
    statement,
    "unsafe",
    pointerUnit,
    postgresTarget("const sql = postgres(DB_URL!);", `sql\`${statement}\``),
  );
}
for (const [shape, statement] of [
  ["ANY array comparison", "SELECT id FROM public.bookings WHERE id = ANY (ARRAY['booking-a'])"],
  ["ANY subquery comparison", "SELECT id FROM public.bookings WHERE id = ANY (SELECT id FROM public.bookings)"],
  ["CASE expression grouping", "SELECT id FROM public.bookings WHERE CASE WHEN true THEN (id IS NOT NULL) ELSE (id IS NULL) END"],
  ["simple CASE operand grouping", "SELECT id FROM public.bookings WHERE CASE (id) WHEN ('booking-a') THEN (true) ELSE (true) END"],
  ["ROW value constructors", "SELECT id FROM public.bookings WHERE ROW(id) = ROW('booking-a')"],
  ["ARRAY subquery constructor", "SELECT id FROM public.bookings WHERE id = ANY (ARRAY(SELECT id FROM public.bookings))"],
  ["CUBE grouping", "SELECT id FROM public.bookings GROUP BY CUBE (id)"],
  ["ROLLUP grouping", "SELECT id FROM public.bookings GROUP BY ROLLUP (id)"],
  ["GROUPING SETS", "SELECT id FROM public.bookings GROUP BY GROUPING SETS ((id), ())"],
  ["CTE column aliases", "WITH visible(id) AS (SELECT id FROM public.bookings) SELECT id FROM visible"],
  ["derived-table column aliases", "SELECT visible.id FROM (SELECT id FROM public.bookings) visible(id)"],
  ["parenthesized set operand", "SELECT id FROM public.bookings INTERSECT (SELECT id FROM public.bookings)"],
  ["FETCH count", "SELECT id FROM public.bookings FETCH FIRST (1) ROWS ONLY"],
  ["BETWEEN operands", "SELECT id FROM public.bookings WHERE id BETWEEN ('a') AND ('z')"],
  ["AT TIME ZONE operand", "SELECT id FROM public.bookings WHERE CURRENT_TIMESTAMP AT TIME ZONE ('UTC') IS NOT NULL"],
  ["time precision", "SELECT id FROM public.bookings WHERE LOCALTIMESTAMP(3) IS NOT NULL"],
  ["WINDOW definition", "SELECT id FROM public.bookings WINDOW booking_window AS (PARTITION BY id)"],
  ["LIMIT expression", "SELECT id FROM public.bookings LIMIT (1)"],
] as const) {
  regress(
    "sql:parenthesized-syntax",
    shape,
    "safe",
    pointerUnit,
    postgresTarget("const sql = postgres(DB_URL!);", `sql\`${statement}\``),
  );
}
for (const [shape, call] of [
  ["unqualified FILTER call", "filter(id)"],
  ["qualified FILTER call", "public.filter(id)"],
  ["qualified OVER call", "public.over(id)"],
  ["qualified WHERE call", "public.where(id)"],
  ["qualified ANY call", "public.any(id)"],
  ["quoted ROW call", '"row"(id)'],
] as const) {
  regress(
    "sql:keyword-call-ambiguity",
    shape,
    "unsafe",
    pointerUnit,
    postgresTarget("const sql = postgres(DB_URL!);", `sql\`SELECT id, ${call} FROM public.bookings\``),
  );
}

regress(
  "postgres:helper-return",
  "local helper preserves imported factory provenance",
  "safe",
  pointerUnit,
  postgresTarget("function makeSql() { return pgFactory(DB_URL!); } const sql = makeSql();")
    .replace('import postgres from "postgres";', 'import { default as pgFactory } from "postgres";'),
);
regress(
  "postgres:helper-return",
  "fake helper cannot borrow provenance from inert import",
  "unsafe",
  pointerUnit,
  postgresTarget("function makeSql() { return (() => Promise.resolve([])) as never; } const sql = makeSql();"),
);
regress(
  "postgres:helper-return",
  "branch-ambiguous helper fails closed",
  "unsafe",
  pointerUnit,
  postgresTarget("function makeSql() { if (process.env.FAKE) return (() => Promise.resolve([])) as never; return postgres(DB_URL!); } const sql = makeSql();"),
);

for (const [mutation, operation, successOnly] of [
  ["INSERT", 'db.from("bookings").insert([{ id: "allowed" }]).select("id")', 'db.from("bookings").insert([{ id: "allowed" }])'],
  ["UPDATE", 'db.from("bookings").update({ status: "updated" }).eq("id", "allowed").select("id")', 'db.from("bookings").update({ status: "updated" }).eq("id", "allowed")'],
  ["DELETE", 'db.from("bookings").delete().eq("id", "allowed").select("id")', 'db.from("bookings").delete().eq("id", "allowed")'],
  ["UPSERT", 'db.from("bookings").upsert([{ id: "allowed" }]).select("id")', 'db.from("bookings").upsert([{ id: "allowed" }])'],
] as const) {
  regress(
    "mutation:affected-rows",
    `${mutation} omits the declared denied attempt`,
    "unsafe",
    pointerUnit,
    supabaseTarget("const db = createClient(DB_URL!, \"key\");", operation)
      .replace("allowedIds: []", 'allowedIds: ["allowed"]'),
  );
  regress("mutation:success-only", `${mutation} without affected IDs`, "unsafe", pointerUnit, supabaseTarget("const db = createClient(DB_URL!, \"key\");", successOnly));
  regress(
    "mutation:fake-receiver",
    `${mutation} affected IDs from fake receiver`,
    "unsafe",
    pointerUnit,
    supabaseTarget("createClient(DB_URL!, \"key\"); const db = fake;", operation),
  );
}

for (const [mutation, operation] of [
  ["INSERT", 'async () => { const { error } = await db.from("bookings").insert([{ id: "booking-a" }]).select("id"); if (error?.code !== "42501") throw new Error("expected denial"); return db.from("bookings").insert([{ id: "allowed" }]).select("id"); }'],
  ["UPDATE", '() => { const ids = ["allowed", "booking-a"]; return db.from("bookings").update({ status: "updated" }).in("id", ids).select("id"); }'],
  ["DELETE", '() => { const ids = ["allowed", "booking-a"]; return db.from("bookings").delete().in("id", ids).select("id"); }'],
  ["UPSERT", 'async () => { const denied = await db.from("bookings").upsert([{ id: "booking-a" }]).select("id"); if (denied.error?.code !== "42501") throw new Error("expected denial"); return db.from("bookings").upsert([{ id: "allowed" }]).select("id"); }'],
] as const) {
  regress(
    "mutation:attempted-effects",
    `${mutation} proves allowed and denied attempts`,
    "safe",
    pointerUnit,
    supabaseTarget("const db = createClient(DB_URL!, \"key\");", "placeholder")
      .replace("query: () => placeholder", `query: ${operation}`)
      .replace("allowedIds: []", 'allowedIds: ["allowed"]'),
  );
}

regress(
  "effects:unknown-loop",
  "second while iteration mutates loader",
  "unsafe",
  supabaseLoader("let action = () => {}; while (process.env.AGAIN) { action(); action = () => { loader = fake; }; }"),
);
regress("effects:unknown-loop", "unknown-count no-op loop", "safe", supabaseLoader("let action = () => {}; while (process.env.AGAIN) { action(); action = () => {}; }"));
regress("effects:unknown-loop", "definite zero-iteration loop", "safe", supabaseLoader("let action = () => { loader = fake; }; while (false) { action(); }"));
regress("effects:unknown-loop", "second do-while iteration mutates loader", "unsafe", supabaseLoader("let action = () => {}; do { action(); action = () => { loader = fake; }; } while (process.env.AGAIN);"));
regress("effects:unknown-loop", "definite one-iteration do-while control", "safe", supabaseLoader("let action = () => {}; do { action(); action = () => { loader = fake; }; } while (false);"));

regress("effects:void", "void operand mutates loader", "unsafe", supabaseLoader("void (() => { loader = fake; })();"));
regress("effects:void", "void non-witness expression", "safe", supabaseLoader("void 0;"));
regress(
  "witness:void",
  "void operand executes second unawaited witness",
  "unsafe",
  pointerUnit,
  supabaseTarget("const db = createClient(DB_URL!, \"key\");", undefined, "class Extra { constructor() { void assertIsolationQuery({ query: () => db.from(\"bookings\").select(\"id\"), allowedIds: [], deniedIds: [\"booking-a\"] }); } } new Extra();"),
);
regress("witness:void", "void non-witness control", "safe", pointerUnit, supabaseTarget("const db = createClient(DB_URL!, \"key\");", undefined, "void Promise.resolve();"));

regress("aliases:branch-mock", "framework then no-op branches", "unsafe", unit('let mock; if (process.env.X) mock = vi.mock; else mock = () => {}; mock("@supabase/supabase-js");'));
regress("aliases:branch-mock", "no-op then framework branches", "unsafe", unit('let mock; if (process.env.X) mock = () => {}; else mock = vi.mock; mock("@supabase/supabase-js");'));
regress("aliases:branch-mock", "destructured framework branch", "unsafe", unit('let mock; if (process.env.X) ({ mock } = vi); else mock = () => {}; mock("@supabase/supabase-js");'));
regress("aliases:branch-mock", "both branches no-op", "safe", unit('let mock; if (process.env.X) mock = () => {}; else mock = () => {}; mock("@supabase/supabase-js");'));

regress("aliases:branch-registration", "it then test branches", "safe", pointerUnit, assignedRegistrationTarget("if (process.env.X) register = it; else register = test;"));
regress("aliases:branch-registration", "test then it branches", "safe", pointerUnit, assignedRegistrationTarget("if (process.env.X) register = test; else register = it;"));
regress("aliases:branch-registration", "framework then no-op branches", "unsafe", pointerUnit, assignedRegistrationTarget("if (process.env.X) register = it; else register = () => {};"));
regress("aliases:branch-registration", "no-op then framework branches", "unsafe", pointerUnit, assignedRegistrationTarget("if (process.env.X) register = () => {}; else register = test;"));
regress("aliases:branch-registration", "destructured framework and test branches", "safe", pointerUnit, assignedRegistrationTarget("if (process.env.X) ({ it: register } = vitest); else register = test;"));
regress("aliases:branch-registration", "destructured framework and no-op branches", "unsafe", pointerUnit, assignedRegistrationTarget("if (process.env.X) ({ it: register } = vitest); else register = () => {};"));

regress("effects:class-static", "static block mutates loader", "unsafe", supabaseLoader("class Mutator { static { loader = fake; } }"));
regress("effects:class-static", "static block no-op", "safe", supabaseLoader("class Noop { static {} }"));
regress("effects:class-inheritance", "default child constructor invokes mutating base", "unsafe", supabaseLoader("class Base { constructor() { loader = fake; } } class Child extends Base {} new Child();"));
regress("effects:class-inheritance", "explicit super invokes mutating base", "unsafe", supabaseLoader("class Base { constructor() { loader = fake; } } class Child extends Base { constructor() { super(); } } new Child();"));
regress("effects:class-inheritance", "default child constructor with no-op base", "safe", supabaseLoader("class Base { constructor() {} } class Child extends Base {} new Child();"));

regress("effects:generator-yield", "first next stops before post-yield mutation", "safe", supabaseLoader("function* mutate() { yield 1; loader = fake; } mutate().next();"));
regress("effects:generator-yield", "second next reaches post-yield mutation", "unsafe", supabaseLoader("function* mutate() { yield 1; loader = fake; } const iterator = mutate(); iterator.next(); iterator.next();"));
regress("effects:generator-yield", "first next includes pre-yield mutation", "unsafe", supabaseLoader("function* mutate() { loader = fake; yield 1; } mutate().next();"));
regress("effects:generator-yield", "two no-op generator advances", "safe", supabaseLoader("function* noop() { yield 1; } const iterator = noop(); iterator.next(); iterator.next();"));

regress("sql:read-only", "SELECT INTO creates a table", "unsafe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT id INTO public.bookings_copy FROM public.bookings`"));
regress("sql:read-only", "ordinary SELECT without INTO", "safe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT id FROM public.bookings`"));
regress("sql:read-only", "INTO text in a string remains read-only", "safe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT 'INTO public.bookings_copy' AS note, id FROM public.bookings`"));

regress("aliases:switch-mock", "switch joins framework and no-op", "unsafe", unit('let mock; switch (process.env.X) { case "yes": mock = vi.mock; break; default: mock = () => {}; } mock("@supabase/supabase-js");'));
regress("aliases:switch-mock", "switch joins only no-ops", "safe", unit('let mock; switch (process.env.X) { case "yes": mock = () => {}; break; default: mock = () => {}; } mock("@supabase/supabase-js");'));
regress("aliases:switch-registration", "switch joins it and test", "safe", pointerUnit, assignedRegistrationTarget('switch (process.env.X) { case "yes": register = it; break; default: register = test; }'));
regress("aliases:switch-registration", "switch joins framework and no-op", "unsafe", pointerUnit, assignedRegistrationTarget('switch (process.env.X) { case "yes": register = it; break; default: register = () => {}; }'));

regress("aliases:try-mock", "try catch joins framework and no-op", "unsafe", unit('let mock; try { mock = vi.mock; } catch { mock = () => {}; } mock("@supabase/supabase-js");'));
regress("aliases:try-mock", "try catch joins only no-ops", "safe", unit('let mock; try { mock = () => {}; } catch { mock = () => {}; } mock("@supabase/supabase-js");'));
regress("aliases:try-registration", "try catch joins it and test", "safe", pointerUnit, assignedRegistrationTarget("try { register = it; } catch { register = test; }"));
regress("aliases:try-registration", "try catch joins framework and no-op", "unsafe", pointerUnit, assignedRegistrationTarget("try { register = it; } catch { register = () => {}; }"));

regress("aliases:loop-mock", "zero-iteration path preserves framework", "unsafe", unit('let mock = vi.mock; while (process.env.X) { mock = () => {}; break; } mock("@supabase/supabase-js");'));
regress("aliases:loop-mock", "zero-iteration path preserves no-op", "safe", unit('let mock = () => {}; while (process.env.X) { mock = () => {}; break; } mock("@supabase/supabase-js");'));
regress("aliases:loop-registration", "zero or one iteration stays framework", "safe", pointerUnit, assignedRegistrationTarget("register = it; while (process.env.X) { register = test; break; }"));
regress("aliases:loop-registration", "iteration may replace framework with no-op", "unsafe", pointerUnit, assignedRegistrationTarget("register = it; while (process.env.X) { register = () => {}; break; }"));

regress("effects:class-super-order", "pre-super restore precedes mutating base", "unsafe", supabaseLoader("const real = loader; class Base { constructor() { loader = fake; } } class Child extends Base { constructor() { loader = real; super(); } } new Child();"));
regress("effects:class-super-order", "post-super restore follows mutating base", "safe", supabaseLoader("const real = loader; class Base { constructor() { loader = fake; } } class Child extends Base { constructor() { super(); loader = real; } } new Child();"));
regress("effects:class-super-order", "pre and post no-op constructor effects", "safe", supabaseLoader("class Base { constructor() {} } class Child extends Base { constructor() { const value = 1; super(); void value; } } new Child();"));

regress("effects:class-super-args", "base invokes mutating super callback", "unsafe", supabaseLoader("class Base { constructor(run: () => void) { run(); } } class Child extends Base { constructor() { super(() => { loader = fake; }); } } new Child();"));
regress("effects:class-super-args", "base invokes no-op super callback", "safe", supabaseLoader("class Base { constructor(run: () => void) { run(); } } class Child extends Base { constructor() { super(() => {}); } } new Child();"));
regress("effects:class-super-args", "super argument expression mutates loader", "unsafe", supabaseLoader("class Base { constructor(_value: unknown) {} } class Child extends Base { constructor() { super((loader = fake, null)); } } new Child();"));

regress("effects:generator-instance", "same call site keeps first mutating arguments", "unsafe", supabaseLoader("function* run(action: () => void) { action(); yield 1; } function make(action: () => void) { return run(action); } const first = make(() => { loader = fake; }); const second = make(() => {}); first.next(); void second;"));
regress("effects:generator-instance", "unadvanced mutating iterator does not taint first", "safe", supabaseLoader("function* run(action: () => void) { action(); yield 1; } function make(action: () => void) { return run(action); } const first = make(() => {}); const second = make(() => { loader = fake; }); first.next(); void second;"));
regress("effects:generator-instance", "both same-site iterators retain no-op arguments", "safe", supabaseLoader("function* run(action: () => void) { action(); yield 1; } function make(action: () => void) { return run(action); } const first = make(() => {}); const second = make(() => {}); first.next(); second.next();"));

regress("aliases:path-conditional", "conditional arm installs framework mock", "unsafe", unit('let mock = () => {}; process.env.X ? mock = vi.mock : mock = () => {}; mock("@supabase/supabase-js");'));
regress("aliases:path-conditional", "conditional arms install no-ops", "safe", unit('let mock = () => {}; process.env.X ? mock = () => {} : mock = () => {}; mock("@supabase/supabase-js");'));
regress("aliases:path-logical", "logical assignment may install framework mock", "unsafe", unit('let mock = () => {}; mock ||= vi.mock; mock("@supabase/supabase-js");'));
regress("aliases:path-logical", "logical assignment retains no-op", "safe", unit('let mock = () => {}; mock ||= () => {}; mock("@supabase/supabase-js");'));
regress("aliases:path-nested", "nested object assignment installs framework mock", "unsafe", unit('let mock; ({ nested: { mock } } = { nested: { mock: vi.mock } }); mock("@supabase/supabase-js");'));
regress("aliases:path-nested", "nested object assignment installs no-op", "safe", unit('let mock; ({ nested: { mock } } = { nested: { mock: () => {} } }); mock("@supabase/supabase-js");'));
regress("aliases:path-default", "array default installs framework mock", "unsafe", unit('let mock; [mock = vi.mock] = []; mock("@supabase/supabase-js");'));
regress("aliases:path-default", "array default installs no-op", "safe", unit('let mock; [mock = () => {}] = []; mock("@supabase/supabase-js");'));
regress("aliases:path-rest", "object rest resolver is explicitly unsupported", "unsafe", unit('let namespace; ({ ...namespace } = vi); namespace.mock("@supabase/supabase-js");'));

regress("aliases:switch-path", "case label installs framework mock", "unsafe", unit('let mock = () => {}; switch (process.env.X) { case (mock = vi.mock, "yes"): break; } mock("@supabase/supabase-js");'));
regress("aliases:switch-path", "case label installs no-op", "safe", unit('let mock = () => {}; switch (process.env.X) { case (mock = () => {}, "yes"): break; } mock("@supabase/supabase-js");'));
regress("aliases:switch-path", "fallthrough installs framework mock", "unsafe", unit('let mock = () => {}; switch (process.env.X) { case "yes": mock = vi.mock; default: break; } mock("@supabase/supabase-js");'));
regress("aliases:switch-path", "fallthrough keeps no-op", "safe", unit('let mock = () => {}; switch (process.env.X) { case "yes": mock = () => {}; default: break; } mock("@supabase/supabase-js");'));
regress("aliases:switch-path", "conditional break preserves framework alternative", "unsafe", unit('let mock = vi.mock; switch (process.env.X) { case "yes": if (process.env.Y) break; mock = () => {}; break; default: mock = () => {}; } mock("@supabase/supabase-js");'));
regress("aliases:switch-path", "conditional break preserves only no-ops", "safe", unit('let mock = () => {}; switch (process.env.X) { case "yes": if (process.env.Y) break; mock = () => {}; break; default: mock = () => {}; } mock("@supabase/supabase-js");'));
regress("aliases:switch-path", "conditional break retains every fallthrough alternative", "unsafe", unit('let mock = () => {}; switch (process.env.X) { case "yes": if (process.env.Y) break; if (process.env.Z) mock = () => {}; else mock = vi.mock; default: } mock("@supabase/supabase-js");'));

regress("aliases:try-path", "may-throw continuation preserves framework assignment", "unsafe", unit('let mock = () => {}; try { mock = vi.mock; unknownCall(); mock = () => {}; } catch {} mock("@supabase/supabase-js");'));
regress("aliases:try-path", "may-throw continuation preserves only no-op", "safe", unit('let mock = () => {}; try { mock = () => {}; unknownCall(); mock = () => {}; } catch {} mock("@supabase/supabase-js");'));
regress("aliases:try-path", "finally overwrites every path with no-op", "safe", unit('let mock = vi.mock; try { unknownCall(); } catch {} finally { mock = () => {}; } mock("@supabase/supabase-js");'));

regress("aliases:for-each-path", "for-of target installs framework mock", "unsafe", unit('let mock = () => {}; for (mock of [vi.mock]) {} mock("@supabase/supabase-js");'));
regress("aliases:for-each-path", "for-of target installs no-op", "safe", unit('let mock = () => {}; for (mock of [() => {}]) {} mock("@supabase/supabase-js");'));
regress("aliases:for-each-path", "for-of destructuring installs framework mock", "unsafe", unit('let mock = () => {}; for ({ mock } of [vi]) {} mock("@supabase/supabase-js");'));
regress("aliases:for-each-path", "for-of destructuring installs no-op", "safe", unit('let mock = () => {}; for ({ mock } of [{ mock: () => {} }]) {} mock("@supabase/supabase-js");'));
regress("aliases:for-each-path", "for-of array hole target installs framework mock", "unsafe", unit('let mock = () => {}; for ([, mock] of [[0, vi.mock]]) {} mock("@supabase/supabase-js");'));
regress("aliases:for-each-path", "for-of array hole target installs no-op", "safe", unit('let mock = () => {}; for ([, mock] of [[0, () => {}]]) {} mock("@supabase/supabase-js");'));
regress("aliases:loop-fixed-point", "later loop iteration retains framework alternative", "unsafe", unit('let mock = () => {}; let next = vi.mock; while (process.env.X) { mock = next; next = () => {}; } mock("@supabase/supabase-js");'));
regress("aliases:loop-fixed-point", "fixed-point loop retains only no-ops", "safe", unit('let mock = () => {}; let next = () => {}; while (process.env.X) { mock = next; next = () => {}; } mock("@supabase/supabase-js");'));
regress("aliases:resolver-unsupported", "dynamic framework member is explicitly unsupported", "unsafe", unit('const name = process.env.X; const mock = vi[name!]; mock("@supabase/supabase-js");'));

regress("effects:generator-frame", "suspended iterator retains first mutating argument", "unsafe", supabaseLoader("function* run(action: () => void) { yield 1; action(); } function make(action: () => void) { return run(action); } const first = make(() => { loader = fake; }); const second = make(() => {}); first.next(); second.next(); first.next();"));
regress("effects:generator-frame", "suspended iterator safe inverse keeps first no-op", "safe", supabaseLoader("function* run(action: () => void) { yield 1; action(); } function make(action: () => void) { return run(action); } const first = make(() => {}); const second = make(() => { loader = fake; }); first.next(); second.next(); first.next();"));
regress("effects:generator-control", "generator return is explicitly unsupported", "unsafe", supabaseLoader("function* mutate() { yield 1; loader = fake; } const iterator = mutate(); iterator.next(); iterator.return();"));
regress("effects:generator-control", "generator throw is explicitly unsupported", "unsafe", supabaseLoader("function* mutate() { yield 1; loader = fake; } const iterator = mutate(); iterator.next(); iterator.throw(new Error());"));
regress("effects:generator-control", "generator spread consumption is explicitly unsupported", "unsafe", supabaseLoader("function* mutate() { loader = fake; yield 1; } [...mutate()];"));

regress("effects:class-field", "instance field initializer mutates loader", "unsafe", supabaseLoader("class Mutator { value = (loader = fake); } new Mutator();"));
regress("effects:class-field", "instance field no-op control", "safe", supabaseLoader("class Noop { value = 1; } new Noop();"));
regress("effects:class-field-order", "base field mutation precedes constructor restore", "safe", supabaseLoader("const real = loader; class Base { value = (loader = fake); constructor() { loader = real; } } new Base();"));
regress("effects:class-field-order", "base constructor mutation follows field no-op", "unsafe", supabaseLoader("class Base { value = 1; constructor() { loader = fake; } } new Base();"));
regress("effects:class-field-order", "derived field restores base mutation after super", "safe", supabaseLoader("const real = loader; class Base { constructor() { loader = fake; } } class Child extends Base { value = (loader = real); constructor() { super(); } } new Child();"));
regress("effects:class-field-order", "derived field mutates after no-op super", "unsafe", supabaseLoader("class Base { constructor() {} } class Child extends Base { value = (loader = fake); constructor() { super(); } } new Child();"));
regress("effects:class-default", "constructor default parameter mutates loader", "unsafe", supabaseLoader("class Mutator { constructor(_value = (loader = fake)) {} } new Mutator(undefined);"));
regress("effects:class-default", "constructor default parameter no-op", "safe", supabaseLoader("class Noop { constructor(_value = 1) {} } new Noop(undefined);"));
regress("effects:class-definition", "computed member name mutates loader", "unsafe", supabaseLoader("class Mutator { [loader = fake]() {} } void Mutator;"));
regress("effects:class-definition", "computed member name no-op", "safe", supabaseLoader("class Noop { [\"value\"]() {} } void Noop;"));
regress("effects:class-unsupported", "decorated class is explicitly unsupported", "unsafe", supabaseLoader("function decorate(value: unknown) { return value; } @decorate class Mutator {} void Mutator;"));
regress("effects:class-unsupported", "private class field is explicitly unsupported", "unsafe", supabaseLoader("class Mutator { #value = 1; } new Mutator();"));
regress("effects:class-unsupported", "class accessor is explicitly unsupported", "unsafe", supabaseLoader("class Mutator { get value() { return 1; } } new Mutator();"));
regress("effects:class-unsupported", "invoked class method is explicitly unsupported", "unsafe", supabaseLoader("class Mutator { run() { loader = fake; } } new Mutator().run();"));
regress("effects:class-unsupported", "uninvoked class method remains safe", "safe", supabaseLoader("class Noop { run() {} } new Noop();"));
regress("effects:class-unsupported", "conditional super is explicitly unsupported", "unsafe", supabaseLoader("class Base {} class Child extends Base { constructor() { if (process.env.X) super(); else super(); } } new Child();"));

regress("effects:recursive-child", "computed element key mutates loader", "unsafe", supabaseLoader("const object = { value: 1 }; void object[(loader = fake, \"value\")];"));
regress("effects:recursive-child", "computed element key no-op", "safe", supabaseLoader("const object = { value: 1 }; void object[(1, \"value\")];"));
regress("effects:recursive-child", "template substitution mutates loader", "unsafe", supabaseLoader("void `${(loader = fake, \"x\")}`;"));
regress("effects:recursive-child", "template substitution no-op", "safe", supabaseLoader("void `${\"x\"}`;"));
regress("effects:recursive-child", "unary operand invokes mutator", "unsafe", supabaseLoader("const mutate = () => { loader = fake; return 1; }; void +mutate();"));
regress("effects:recursive-child", "unary operand invokes no-op", "safe", supabaseLoader("const noop = () => 1; void +noop();"));
regress("effects:recursive-child", "object computed name mutates loader", "unsafe", supabaseLoader("void { [(loader = fake, \"value\")]: 1 };"));
regress("effects:recursive-child", "object computed name no-op", "safe", supabaseLoader("void { [\"value\"]: 1 };"));

regress("sql:typed-token", "quoted INTO identifier remains read-only", "safe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT \"into\", id FROM public.bookings`"));
regress("sql:typed-token", "unquoted INTO clause remains mutating", "unsafe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT id INTO public.bookings_copy FROM public.bookings`"));
regress("sql:typed-token", "INTO alias remains contextual", "safe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT id AS into FROM public.bookings`"));
regress("sql:reviewed-literal", "semantic literal whitespace cannot borrow a reviewed statement", "unsafe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT 'INTO  public.bookings_copy' AS note, id FROM public.bookings`"));
regress("sql:typed-token", "Postgres E-string hides mutation words", "safe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT E'quote\\\\' INTO public.copy' AS note, id FROM public.bookings`"));
regress("sql:typed-token", "unterminated E-string fails closed", "unsafe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT E'unterminated FROM public.bookings`"));
regress("sql:typed-token", "unterminated quoted identifier fails closed", "unsafe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT id FROM \"public.bookings`"));
regress("sql:typed-token", "quoted relation identifiers retain resource", "safe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT id FROM \"public\".\"bookings\"`"));
regress("sql:typed-token", "ONLY relation modifier retains resource", "safe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT id FROM ONLY public.bookings`"));
regress("sql:typed-token", "LATERAL relation modifier retains nested resource", "safe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT visible.id FROM LATERAL (SELECT id FROM public.bookings) visible`"));

const mixedPrimaryRegistration = (alternate: string) => registrationTarget("primary").replace(
  'describe("RLS integration", () => {',
  `const primary = process.env.PRIMARY ? it : ${alternate};\ndescribe("RLS integration", () => {`,
);
regress(
  "registration:mixed-primary",
  "Vitest it or no-op retains unknown test registration",
  "unsafe",
  pointerUnit,
  mixedPrimaryRegistration("((_name: string, _callback: () => void) => {})"),
);
regress(
  "registration:mixed-primary",
  "Vitest it or test retains enabled test registration",
  "safe",
  pointerUnit,
  mixedPrimaryRegistration("test"),
);

const tryIntermediateTarget = (operation: string, assignment: string) => supabaseTarget(
  `const real = createClient(DB_URL!, "key"); let db = real; try { ${assignment}; ${operation}; db = real; } catch {}`,
);
for (const [shape, operation] of [
  ["unresolved call", "unknownCall()"],
  ["unresolved new", "new UnknownThing()"],
  ["unresolved await", "await unknownPromise"],
  ["unresolved tag", "unknownTag`value`"],
] as const) {
  regress("effects:try-intermediate", `${shape} retains preceding mutation`, "unsafe", pointerUnit, tryIntermediateTarget(operation, "db = fake"));
  regress("effects:try-intermediate", `${shape} no-op inverse`, "safe", pointerUnit, tryIntermediateTarget(operation, "db = real"));
}

regress(
  "effects:generic-for-of",
  "aliased array later iteration mutates loader",
  "unsafe",
  supabaseLoader("const actions = [() => {}, () => { loader = fake; }]; const iterable = actions; for (const action of iterable) action();"),
);
regress(
  "effects:generic-for-of",
  "aliased array iterations are no-ops",
  "safe",
  supabaseLoader("const actions = [() => {}, () => {}]; const iterable = actions; for (const action of iterable) action();"),
);
regress(
  "effects:generic-for-of-alias-mutation",
  "earlier iteration replaces later slot with mutator",
  "unsafe",
  supabaseLoader("const actions = [() => {}, () => {}]; for (const action of actions) { actions[1] = () => { loader = fake; }; action(); }"),
);
regress(
  "effects:generic-for-of-alias-mutation",
  "earlier iteration replaces later slot with no-op",
  "safe",
  supabaseLoader("const actions = [() => {}, () => {}]; for (const action of actions) { actions[1] = () => {}; action(); }"),
);
regress(
  "effects:promise-all-array",
  "Promise.all array later iteration mutates loader",
  "unsafe",
  supabaseLoader("const actions = await Promise.all([() => {}, () => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-array",
  "Promise.all array iterations are no-ops",
  "safe",
  supabaseLoader("const actions = await Promise.all([() => {}, () => {}]); for (const action of actions) action();"),
);

regress(
  "effects:generator-for-of",
  "later generator iteration mutates loader",
  "unsafe",
  supabaseLoader("function* actions() { yield () => {}; yield () => { loader = fake; }; } for (const action of actions()) action();"),
);
regress(
  "effects:generator-for-of",
  "generator iterations are no-ops",
  "safe",
  supabaseLoader("function* actions() { yield () => {}; yield () => {}; } for (const action of actions()) action();"),
);

regress(
  "effects:generator-heap-frame",
  "suspended iterator retains its object member allocation",
  "unsafe",
  supabaseLoader("function* run(action: () => void) { const box = { action }; yield 1; box.action(); } function make(action: () => void) { return run(action); } const first = make(() => { loader = fake; }); const second = make(() => {}); first.next(); second.next(); first.next();"),
);
regress(
  "effects:generator-heap-frame",
  "suspended iterator does not borrow another object's mutator",
  "safe",
  supabaseLoader("function* run(action: () => void) { const box = { action }; yield 1; box.action(); } function make(action: () => void) { return run(action); } const first = make(() => {}); const second = make(() => { loader = fake; }); first.next(); second.next(); first.next();"),
);

regress("effects:default-argument", "omitted argument runs mutating default", "unsafe", supabaseLoader("function run(action = () => { loader = fake; }) { action(); } run();"));
regress("effects:default-argument", "omitted argument runs no-op default", "safe", supabaseLoader("function run(action = () => {}) { action(); } run();"));
regress("effects:default-argument", "global undefined runs mutating default", "unsafe", supabaseLoader("function run(action = () => { loader = fake; }) { action(); } run(undefined);"));
regress("effects:default-argument", "shadowed undefined remains supplied", "safe", supabaseLoader("function run(action = () => { loader = fake; }) { action(); } function call(undefined: () => void) { run(undefined); } call(() => {});"));
regress("effects:default-argument", "unknown supplied value retains mutating default alternative", "unsafe", supabaseLoader("function run(action = () => { loader = fake; }) { action(); } run(unknownAction);"));
regress("effects:default-argument", "unknown supplied value with no-op default", "safe", supabaseLoader("function run(action = () => {}) { action(); } run(unknownAction);"));

regress("sql:parentheses", "unmatched opening parenthesis fails closed", "unsafe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT id FROM public.bookings WHERE (true`"));
regress("sql:parentheses", "unmatched closing parenthesis fails closed", "unsafe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT id FROM public.bookings WHERE true)`"));
regress("sql:parentheses", "balanced nested SELECT remains read-only", "safe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT id FROM public.bookings WHERE id IN (SELECT id FROM public.bookings)`"));

for (const lockingClause of ["FOR UPDATE", "FOR NO KEY UPDATE", "FOR SHARE", "FOR KEY SHARE"] as const) {
  regress(
    "sql:locking-clause",
    `${lockingClause} is not read-only`,
    "unsafe",
    pointerUnit,
    postgresTarget("const sql = postgres(DB_URL!);", `sql\`SELECT id FROM public.bookings ${lockingClause}\``),
  );
}
regress("sql:locking-clause", "plain balanced SELECT inverse", "safe", pointerUnit, postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT id FROM public.bookings WHERE (id IS NOT NULL)`"));

regress(
  "effects:try-post-callback-throw",
  "external runner may invoke mutator before throwing",
  "unsafe",
  supabaseLoader("const real = loader; try { runTask(() => { loader = fake; }); loader = real; } catch {}"),
);
regress(
  "effects:try-post-callback-throw",
  "external runner no-op callback inverse",
  "safe",
  supabaseLoader("const real = loader; try { runTask(() => {}); loader = real; } catch {}"),
);
regress(
  "effects:try-post-callback-throw",
  "proven local runner cannot throw after callback",
  "safe",
  supabaseLoader("const real = loader; const runTask = (callback: () => void) => callback(); try { runTask(() => { loader = fake; }); loader = real; } catch {}"),
);

regress(
  "effects:invocation-object-frame",
  "first returned object retains mutating member",
  "unsafe",
  supabaseLoader("function make(action: () => void) { return { action }; } const first = make(() => { loader = fake; }); const second = make(() => {}); first.action(); void second;"),
);
regress(
  "effects:invocation-object-frame",
  "first returned object does not borrow second mutator",
  "safe",
  supabaseLoader("function make(action: () => void) { return { action }; } const first = make(() => {}); const second = make(() => { loader = fake; }); first.action(); void second;"),
);
regress(
  "effects:invocation-array-frame",
  "first returned array retains mutating element",
  "unsafe",
  supabaseLoader("function make(action: () => void) { return [action]; } const first = make(() => { loader = fake; }); const second = make(() => {}); first[0](); void second;"),
);
regress(
  "effects:invocation-array-frame",
  "first returned array does not borrow second mutator",
  "safe",
  supabaseLoader("function make(action: () => void) { return [action]; } const first = make(() => {}); const second = make(() => { loader = fake; }); first[0](); void second;"),
);
regress(
  "effects:invocation-closure-frame",
  "first returned closure retains mutating parameter",
  "unsafe",
  supabaseLoader("function make(action: () => void) { return () => action(); } const first = make(() => { loader = fake; }); const second = make(() => {}); first(); void second;"),
);
regress(
  "effects:invocation-closure-frame",
  "first returned closure does not borrow second parameter",
  "safe",
  supabaseLoader("function make(action: () => void) { return () => action(); } const first = make(() => {}); const second = make(() => { loader = fake; }); first(); void second;"),
);
regress(
  "effects:live-sibling-closure",
  "nested sibling closure observes live mutating binding",
  "unsafe",
  supabaseLoader("function make(action: () => void) { let current = () => {}; const run = () => current(); return () => { current = action; run(); }; } make(() => { loader = fake; })();"),
);
regress(
  "effects:live-sibling-closure",
  "nested sibling closure observes live no-op binding",
  "safe",
  supabaseLoader("function make(action: () => void) { let current = () => {}; const run = () => current(); return () => { current = action; run(); }; } make(() => {})();"),
);
regress(
  "effects:array-binding-identity",
  "sibling setter updates the destructured runner",
  "unsafe",
  supabaseLoader("function make() { let action = () => {}; return [() => action(), (next: () => void) => { action = next; }]; } const [run, set] = make(); set(() => { loader = fake; }); run();"),
);
regress(
  "effects:array-binding-identity",
  "omitted element selects only the second factory setter",
  "safe",
  supabaseLoader("function make() { let action = () => {}; return [() => action(), (next: () => void) => { action = next; }]; } const [firstRun] = make(); const [, secondSet] = make(); secondSet(() => { loader = fake; }); firstRun();"),
);
regress(
  "effects:array-binding-identity",
  "setter-only destructuring does not invoke its callback",
  "safe",
  supabaseLoader("function make() { let action = () => {}; return [() => action(), (next: () => void) => { action = next; }]; } const [, set] = make(); set(() => { loader = fake; });"),
);
regress(
  "effects:array-binding-default",
  "missing element selects mutating default",
  "unsafe",
  supabaseLoader("const [run = () => { loader = fake; }] = []; run();"),
);
regress(
  "effects:array-binding-default",
  "missing element selects no-op default",
  "safe",
  supabaseLoader("const [run = () => {}] = []; run();"),
);
regress(
  "effects:array-binding-default-effects",
  "missing element executes mutating default",
  "unsafe",
  supabaseLoader("const [value = (loader = fake)] = []; void value;"),
);
regress(
  "effects:array-binding-default-effects",
  "present element suppresses mutating default",
  "safe",
  supabaseLoader("const [value = (loader = fake)] = [loader]; void value;"),
);
regress(
  "effects:array-binding-default-paths",
  "conditional default retains mutating true branch",
  "unsafe",
  supabaseLoader("const [value = (unknownCondition ? (loader = fake) : loader)] = []; void value;"),
);
regress(
  "effects:array-binding-default-paths",
  "conditional default retains mutating false branch",
  "unsafe",
  supabaseLoader("const [value = (unknownCondition ? loader : (loader = fake))] = []; void value;"),
);
regress(
  "effects:array-binding-default-paths",
  "conditional default with two no-op branches",
  "safe",
  supabaseLoader("const [value = (unknownCondition ? loader : loader)] = []; void value;"),
);
regress(
  "effects:object-binding-default-effects",
  "missing property executes mutating default",
  "unsafe",
  supabaseLoader("const { value = (loader = fake) } = {}; void value;"),
);
regress(
  "effects:object-binding-default-effects",
  "present property suppresses mutating default",
  "safe",
  supabaseLoader("const { value = (loader = fake) } = { value: loader }; void value;"),
);
regress(
  "effects:object-binding-default-paths",
  "conditional property default retains mutating true branch",
  "unsafe",
  supabaseLoader("const { value = (unknownCondition ? (loader = fake) : loader) } = {}; void value;"),
);
regress(
  "effects:object-binding-default-paths",
  "conditional property default retains mutating false branch",
  "unsafe",
  supabaseLoader("const { value = (unknownCondition ? loader : (loader = fake)) } = {}; void value;"),
);
regress(
  "effects:object-binding-default-paths",
  "conditional property default with two no-op branches",
  "safe",
  supabaseLoader("const { value = (unknownCondition ? loader : loader) } = {}; void value;"),
);
regress(
  "effects:array-binding-rest",
  "rest element retains mutating callback identity",
  "unsafe",
  supabaseLoader("const [...actions] = [() => { loader = fake; }]; actions[0]();"),
);
regress(
  "effects:array-binding-rest",
  "rest element retains no-op callback identity",
  "safe",
  supabaseLoader("const [...actions] = [() => {}]; actions[0]();"),
);
regress(
  "effects:array-binding-rest",
  "rest array iteration invokes mutating callback",
  "unsafe",
  supabaseLoader("const [...actions] = [() => { loader = fake; }]; for (const action of actions) action();"),
);
regress(
  "effects:array-binding-rest",
  "rest array iteration invokes only no-op callback",
  "safe",
  supabaseLoader("const [...actions] = [() => {}]; for (const action of actions) action();"),
);
regress(
  "effects:class-instance-frame",
  "first returned instance retains mutating member",
  "unsafe",
  supabaseLoader("class Box {} function make(action: () => void) { const box = new Box(); box.action = action; return box; } const first = make(() => { loader = fake; }); const second = make(() => {}); first.action(); void second;"),
);
regress(
  "effects:class-instance-frame",
  "first returned instance does not borrow second mutator",
  "safe",
  supabaseLoader("class Box {} function make(action: () => void) { const box = new Box(); box.action = action; return box; } const first = make(() => {}); const second = make(() => { loader = fake; }); first.action(); void second;"),
);

regress(
  "effects:class-definition-order",
  "computed name restore precedes mutating static field",
  "unsafe",
  supabaseLoader("const real = loader; class C { static value = (loader = fake); [loader = real]() {} } void C;"),
);
regress(
  "effects:class-definition-order",
  "computed name mutation precedes restoring static field",
  "safe",
  supabaseLoader("const real = loader; class C { static value = (loader = real); [loader = fake]() {} } void C;"),
);
regress(
  "effects:class-instance-field-member",
  "invoked function-valued instance field mutates loader",
  "unsafe",
  supabaseLoader("class C { run = () => { loader = fake; }; } new C().run();"),
);
regress(
  "effects:class-instance-field-member",
  "invoked function-valued instance field no-op inverse",
  "safe",
  supabaseLoader("class C { run = () => {}; } new C().run();"),
);
regress(
  "effects:class-instance-field-frame",
  "first instance field closure retains mutating parameter",
  "unsafe",
  supabaseLoader("function make(action: () => void) { class C { run = () => action(); } return new C(); } const first = make(() => { loader = fake; }); const second = make(() => {}); first.run(); void second;"),
);
regress(
  "effects:class-instance-field-frame",
  "first instance field closure does not borrow second parameter",
  "safe",
  supabaseLoader("function make(action: () => void) { class C { run = () => action(); } return new C(); } const first = make(() => {}); const second = make(() => { loader = fake; }); first.run(); void second;"),
);
regress(
  "effects:class-parameter-property",
  "invoked constructor parameter property mutates loader",
  "unsafe",
  supabaseLoader("class C { constructor(public run: () => void) {} } new C(() => { loader = fake; }).run();"),
);
regress(
  "effects:class-parameter-property",
  "invoked constructor parameter property no-op inverse",
  "safe",
  supabaseLoader("class C { constructor(public run: () => void) {} } new C(() => {}).run();"),
);
regress(
  "effects:class-parameter-property-frame",
  "first parameter-property instance retains mutating member",
  "unsafe",
  supabaseLoader("class C { constructor(public run: () => void) {} } function make(action: () => void) { return new C(action); } const first = make(() => { loader = fake; }); const second = make(() => {}); first.run(); void second;"),
);
regress(
  "effects:class-parameter-property-frame",
  "first parameter-property instance does not borrow second member",
  "safe",
  supabaseLoader("class C { constructor(public run: () => void) {} } function make(action: () => void) { return new C(action); } const first = make(() => {}); const second = make(() => { loader = fake; }); first.run(); void second;"),
);
regress(
  "effects:class-field-parameter-property",
  "field closure invokes mutating parameter property through this",
  "unsafe",
  supabaseLoader("class C { run = () => this.action(); constructor(public action: () => void) {} } new C(() => { loader = fake; }).run();"),
);
regress(
  "effects:class-field-parameter-property",
  "field closure invokes no-op parameter property through this",
  "safe",
  supabaseLoader("class C { run = () => this.action(); constructor(public action: () => void) {} } new C(() => {}).run();"),
);

regress(
  "effects:promise-all-overwrite",
  "overwritten Promise.all returns mutating callback",
  "unsafe",
  supabaseLoader("Promise.all = async () => [() => { loader = fake; }]; const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-overwrite",
  "overwritten Promise.all returns no-op callback inverse",
  "safe",
  supabaseLoader("Promise.all = async () => [() => {}]; const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-overwrite",
  "Object.assign Promise.all returns mutating callback",
  "unsafe",
  supabaseLoader("Object.assign(Promise, { all: async () => [() => { loader = fake; }] }); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-overwrite",
  "Object.assign Promise.all returns no-op callback",
  "safe",
  supabaseLoader("Object.assign(Promise, { all: async () => [() => {}] }); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-framework-mutation",
  "spied Promise.all replacement returns mutating callback",
  "unsafe",
  supabaseLoader("vi.spyOn(Promise, 'all').mockImplementation(async () => [() => { loader = fake; }] as never); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-framework-mutation",
  "spied Promise.all replacement returns no-op callback",
  "safe",
  supabaseLoader("vi.spyOn(Promise, 'all').mockImplementation(async () => [() => {}] as never); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:unsupported-vitest-api",
  "vi.replaceProperty fails closed",
  "unsafe",
  supabaseLoader("vi.replaceProperty(Promise, 'all', async () => [() => {}] as never);"),
);
regress(
  "effects:unsupported-vitest-api",
  "vitest.replaceProperty fails closed",
  "unsafe",
  unit('import { vitest } from "vitest"; vitest.replaceProperty(Promise, "all", async () => [] as never); vi.mock("@supabase/supabase-js", async (loader) => ({ ...(await loader()) }));'),
);
regress(
  "effects:promise-all-bound-member",
  "spyOn resolves const-bound Promise member",
  "unsafe",
  supabaseLoader("const member = 'all'; vi.spyOn(Promise, member).mockImplementation(async () => [() => { loader = fake; }] as never); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-bound-member",
  "spyOn const-bound Promise member no-op inverse",
  "safe",
  supabaseLoader("const member = 'all'; vi.spyOn(Promise, member).mockImplementation(async () => [() => {}] as never); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-bound-member",
  "assignment resolves const-bound Promise member",
  "unsafe",
  supabaseLoader("const member = 'all'; Promise[member] = async () => [() => { loader = fake; }] as never; const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-bound-member",
  "assignment const-bound Promise member no-op inverse",
  "safe",
  supabaseLoader("const member = 'all'; Promise[member] = async () => [() => {}] as never; const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-bound-member",
  "literal concatenation still resolves Promise member",
  "unsafe",
  supabaseLoader("vi.spyOn(Promise, 'a' + 'll').mockImplementation(async () => [() => { loader = fake; }] as never); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-bound-member",
  "literal concatenation no-op inverse",
  "safe",
  supabaseLoader("vi.spyOn(Promise, 'a' + 'll').mockImplementation(async () => [() => {}] as never); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-mutable-member",
  "spyOn resolves reassigned let-bound member",
  "unsafe",
  supabaseLoader("let member = 'race'; member = 'all'; vi.spyOn(Promise, member).mockImplementation(async () => [() => { loader = fake; }] as never); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-mutable-member",
  "spyOn reassigned let-bound member no-op inverse",
  "safe",
  supabaseLoader("let member = 'race'; member = 'all'; vi.spyOn(Promise, member).mockImplementation(async () => [() => {}] as never); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-mutable-member",
  "assignment resolves reassigned let-bound member",
  "unsafe",
  supabaseLoader("let member = 'race'; member = 'all'; Promise[member] = async () => [() => { loader = fake; }] as never; const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-mutable-member",
  "assignment reassigned let-bound member no-op inverse",
  "safe",
  supabaseLoader("let member = 'race'; member = 'all'; Promise[member] = async () => [() => {}] as never; const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-computed-configure",
  "definite let-bound configuration method applies",
  "unsafe",
  supabaseLoader("let configure = 'mockReset'; configure = 'mockImplementation'; const spy = vi.spyOn(Promise, 'all'); spy[configure](async () => [() => { loader = fake; }] as never); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-computed-configure",
  "definite let-bound configuration method no-op inverse",
  "safe",
  supabaseLoader("let configure = 'mockReset'; configure = 'mockImplementation'; const spy = vi.spyOn(Promise, 'all'); spy[configure](async () => [() => {}] as never); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-computed-configure",
  "unresolved configuration method fails closed",
  "unsafe",
  supabaseLoader("const configure = process.env.MOCK_METHOD; const spy = vi.spyOn(Promise, 'all'); spy[configure](async () => [() => {}] as never); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-mutable-member",
  "multi-valued conditional member fails closed",
  "unsafe",
  supabaseLoader("const member = unknownCondition ? 'all' : 'race'; vi.spyOn(Promise, member).mockImplementation(async () => [() => {}] as never); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);

regress(
  "effects:array-assignment-default",
  "missing element retains mutating callback identity",
  "unsafe",
  supabaseLoader("let action; [action = () => { loader = fake; }] = []; action();"),
);
regress(
  "effects:array-assignment-default",
  "missing element retains no-op callback identity",
  "safe",
  supabaseLoader("let action; [action = () => {}] = []; action();"),
);
regress(
  "effects:array-assignment-default",
  "present element suppresses mutating default",
  "safe",
  supabaseLoader("let action; [action = () => { loader = fake; }] = [() => {}]; action();"),
);
regress(
  "effects:array-assignment-default",
  "omitted offset selects missing second element",
  "unsafe",
  supabaseLoader("let action; [, action = () => { loader = fake; }] = [() => {}]; action();"),
);
regress(
  "effects:array-assignment-default",
  "omitted offset preserves present second element",
  "safe",
  supabaseLoader("let action; [, action = () => { loader = fake; }] = [() => {}, () => {}]; action();"),
);
regress(
  "effects:array-assignment-default",
  "conditional default retains mutating alternative",
  "unsafe",
  supabaseLoader("let action; [action = (unknownCondition ? () => { loader = fake; } : () => {})] = []; action();"),
);
regress(
  "effects:array-assignment-default",
  "conditional default with only no-op alternatives",
  "safe",
  supabaseLoader("let action; [action = (unknownCondition ? () => {} : () => {})] = []; action();"),
);
regress(
  "effects:array-assignment-alternatives",
  "conditional source retains mutating identity",
  "unsafe",
  supabaseLoader("let action; [action] = unknownCondition ? [() => { loader = fake; }] : [() => {}]; action();"),
);
regress(
  "effects:array-assignment-alternatives",
  "conditional source retains only no-op identities",
  "safe",
  supabaseLoader("let action; [action] = unknownCondition ? [() => {}] : [() => {}]; action();"),
);
regress(
  "effects:array-assignment-default-effects",
  "missing element executes mutating default",
  "unsafe",
  supabaseLoader("let value; [value = (loader = fake)] = []; void value;"),
);
regress(
  "effects:array-assignment-default-effects",
  "present element suppresses mutating default effect",
  "safe",
  supabaseLoader("let value; [value = (loader = fake)] = [loader]; void value;"),
);
regress(
  "effects:object-assignment-default",
  "missing property retains mutating callback identity",
  "unsafe",
  supabaseLoader("let action; ({ action = () => { loader = fake; } } = {}); action();"),
);
regress(
  "effects:object-assignment-default",
  "missing property retains no-op callback identity",
  "safe",
  supabaseLoader("let action; ({ action = () => {} } = {}); action();"),
);
regress(
  "effects:object-assignment-default",
  "present property suppresses mutating default",
  "safe",
  supabaseLoader("let action; ({ action = () => { loader = fake; } } = { action: () => {} }); action();"),
);
regress(
  "effects:object-assignment-default",
  "renamed property retains mutating default identity",
  "unsafe",
  supabaseLoader("let action; ({ run: action = () => { loader = fake; } } = {}); action();"),
);
regress(
  "effects:object-assignment-default",
  "renamed present property suppresses mutating default",
  "safe",
  supabaseLoader("let action; ({ run: action = () => { loader = fake; } } = { run: () => {} }); action();"),
);
regress(
  "effects:object-assignment-rename",
  "renamed property retains mutating callback identity",
  "unsafe",
  supabaseLoader("let action; ({ run: action } = { run: () => { loader = fake; } }); action();"),
);
regress(
  "effects:object-assignment-rename",
  "renamed property retains no-op callback identity",
  "safe",
  supabaseLoader("let action; ({ run: action } = { run: () => {} }); action();"),
);
regress(
  "effects:object-assignment-alternatives",
  "conditional source retains mutating identity",
  "unsafe",
  supabaseLoader("let action; ({ action } = unknownCondition ? { action: () => { loader = fake; } } : { action: () => {} }); action();"),
);
regress(
  "effects:object-assignment-alternatives",
  "conditional source retains only no-op identities",
  "safe",
  supabaseLoader("let action; ({ action } = unknownCondition ? { action: () => {} } : { action: () => {} }); action();"),
);
regress(
  "effects:object-assignment-default-effects",
  "missing property executes mutating default",
  "unsafe",
  supabaseLoader("let value; ({ value = (loader = fake) } = {}); void value;"),
);
regress(
  "effects:object-assignment-default-effects",
  "present property suppresses mutating default effect",
  "safe",
  supabaseLoader("let value; ({ value = (loader = fake) } = { value: loader }); void value;"),
);
regress(
  "effects:promise-all-with-implementation",
  "temporary implementation applies inside callback",
  "unsafe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); await spy.withImplementation(async () => [() => { loader = fake; }] as never, async () => { const actions = await Promise.all([() => {}]); for (const action of actions) action(); });"),
);
regress(
  "effects:promise-all-with-implementation",
  "temporary no-op implementation applies inside callback",
  "safe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); await spy.withImplementation(async () => [() => {}] as never, async () => { const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action(); });"),
);
regress(
  "effects:promise-all-with-implementation",
  "temporary implementation restores after callback",
  "safe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); await spy.withImplementation(async () => [() => { loader = fake; }] as never, async () => {}); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-with-implementation",
  "restored native implementation observes later mutator",
  "unsafe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); await spy.withImplementation(async () => [() => {}] as never, async () => {}); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-with-implementation-lifecycle",
  "sync throw leaves temporary mutating implementation installed",
  "unsafe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); try { spy.withImplementation(async () => [() => { loader = fake; }] as never, () => { throw 1; }); } catch {} const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-with-implementation-lifecycle",
  "sync throw leaves temporary no-op implementation installed",
  "safe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); try { spy.withImplementation(async () => [() => {}] as never, () => { throw 1; }); } catch {} const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-with-implementation-lifecycle",
  "rejection leaves temporary mutating implementation installed",
  "unsafe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); try { await spy.withImplementation(async () => [() => { loader = fake; }] as never, () => Promise.reject()); } catch {} const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-with-implementation-lifecycle",
  "rejection leaves temporary no-op implementation installed",
  "safe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); try { await spy.withImplementation(async () => [() => {}] as never, () => Promise.reject()); } catch {} const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-with-implementation-lifecycle",
  "fulfilled thenable restores native implementation",
  "unsafe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); await spy.withImplementation(async () => [() => {}] as never, () => Promise.resolve()); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-with-implementation-lifecycle",
  "fulfilled thenable restores native safe input",
  "safe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); await spy.withImplementation(async () => [() => { loader = fake; }] as never, () => Promise.resolve()); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-once",
  "one-shot implementation applies to first call",
  "unsafe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementationOnce(async () => [() => { loader = fake; }] as never); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-once",
  "one-shot no-op implementation replaces first mutating input",
  "safe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementationOnce(async () => [() => {}] as never); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-once",
  "consumed one-shot restores native second call",
  "unsafe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementationOnce(async () => [() => {}] as never); await Promise.all([() => {}]); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-once",
  "consumed mutating one-shot does not affect safe second call",
  "safe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementationOnce(async () => [() => { loader = fake; }] as never); await Promise.all([() => {}]); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-once-prior",
  "one-shot consumption resumes prior mutating implementation",
  "unsafe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementation(async () => [() => { loader = fake; }] as never); spy.mockImplementationOnce(async () => [() => {}] as never); await Promise.all([() => {}]); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-once-prior",
  "one-shot consumption resumes prior no-op implementation",
  "safe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementation(async () => [() => {}] as never); spy.mockImplementationOnce(async () => [() => { loader = fake; }] as never); await Promise.all([() => {}]); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-once-queue",
  "successive one-shot implementations are consumed in order",
  "unsafe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementationOnce(async () => [() => {}] as never); spy.mockImplementationOnce(async () => [() => { loader = fake; }] as never); await Promise.all([() => {}]); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-once-queue",
  "second queued no-op does not reuse first mutator",
  "safe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementationOnce(async () => [() => { loader = fake; }] as never); spy.mockImplementationOnce(async () => [() => {}] as never); await Promise.all([() => {}]); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-restore",
  "mockRestore restores native safe input",
  "safe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementation(async () => [() => { loader = fake; }] as never); spy.mockRestore(); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-restore",
  "mockRestore restores native mutating input",
  "unsafe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementation(async () => [() => {}] as never); spy.mockRestore(); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-reset",
  "mockReset restores native safe input",
  "safe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementation(async () => [() => { loader = fake; }] as never); spy.mockReset(); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-reset",
  "mockReset restores native mutating input",
  "unsafe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementation(async () => [() => {}] as never); spy.mockReset(); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-control-ownership",
  "mockRestore detaches control from later configuration",
  "safe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockRestore(); spy.mockImplementation(async () => [() => { loader = fake; }] as never); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-control-ownership",
  "mockRestore detached control cannot hide native mutating input",
  "unsafe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockRestore(); spy.mockImplementation(async () => [() => {}] as never); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-control-ownership",
  "mockReset keeps control attached for later configuration",
  "unsafe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockReset(); spy.mockImplementation(async () => [() => { loader = fake; }] as never); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-control-ownership",
  "mockReset attached control accepts later no-op configuration",
  "safe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockReset(); spy.mockImplementation(async () => [() => {}] as never); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-stacked-spy",
  "restore through first alias detaches repeated spy",
  "unsafe",
  supabaseLoader("const first = vi.spyOn(Promise, 'all'); const second = vi.spyOn(Promise, 'all'); first.mockRestore(); second.mockImplementation(async () => [() => {}] as never); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-stacked-spy",
  "detached repeated alias ignores mutating configuration",
  "safe",
  supabaseLoader("const first = vi.spyOn(Promise, 'all'); const second = vi.spyOn(Promise, 'all'); first.mockRestore(); second.mockImplementation(async () => [() => { loader = fake; }] as never); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-stacked-spy",
  "restore through second alias exposes native mutating input",
  "unsafe",
  supabaseLoader("const first = vi.spyOn(Promise, 'all'); first.mockImplementation(async () => [() => {}] as never); const second = vi.spyOn(Promise, 'all'); second.mockImplementation(async () => [() => { loader = fake; }] as never); second.mockRestore(); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-stacked-spy",
  "restore through second alias discards prior safe mock",
  "safe",
  supabaseLoader("const first = vi.spyOn(Promise, 'all'); first.mockImplementation(async () => [() => {}] as never); const second = vi.spyOn(Promise, 'all'); second.mockImplementation(async () => [() => { loader = fake; }] as never); second.mockRestore(); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-stacked-spy",
  "restoreAllMocks exposes native mutating input",
  "unsafe",
  supabaseLoader("const first = vi.spyOn(Promise, 'all'); first.mockImplementation(async () => [() => {}] as never); const second = vi.spyOn(Promise, 'all'); second.mockImplementation(async () => [() => { loader = fake; }] as never); vi.restoreAllMocks(); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-stacked-spy",
  "restoreAllMocks restores native safe input",
  "safe",
  supabaseLoader("const first = vi.spyOn(Promise, 'all'); first.mockImplementation(async () => [() => { loader = fake; }] as never); const second = vi.spyOn(Promise, 'all'); second.mockImplementation(async () => [() => {}] as never); vi.restoreAllMocks(); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-stacked-spy",
  "reset through first alias remains attached",
  "unsafe",
  supabaseLoader("const first = vi.spyOn(Promise, 'all'); const second = vi.spyOn(Promise, 'all'); first.mockReset(); second.mockImplementation(async () => [() => { loader = fake; }] as never); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-stacked-spy",
  "clearAllMocks preserves repeated spy implementation",
  "safe",
  supabaseLoader("const first = vi.spyOn(Promise, 'all'); first.mockImplementation(async () => [() => {}] as never); const second = vi.spyOn(Promise, 'all'); second.mockImplementation(async () => [() => {}] as never); vi.clearAllMocks(); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-global-lifecycle",
  "restoreAllMocks restores and detaches spy",
  "safe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementation(async () => [() => { loader = fake; }] as never); vi.restoreAllMocks(); spy.mockImplementation(async () => [() => { loader = fake; }] as never); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-global-lifecycle",
  "restoreAllMocks exposes native mutating input",
  "unsafe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementation(async () => [() => {}] as never); vi.restoreAllMocks(); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-global-lifecycle",
  "resetAllMocks keeps spy attached for later configuration",
  "unsafe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementation(async () => [() => {}] as never); vi.resetAllMocks(); spy.mockImplementation(async () => [() => { loader = fake; }] as never); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-global-lifecycle",
  "resetAllMocks attached spy accepts later no-op configuration",
  "safe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementation(async () => [() => { loader = fake; }] as never); vi.resetAllMocks(); spy.mockImplementation(async () => [() => {}] as never); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-global-lifecycle",
  "clearAllMocks preserves mutating implementation",
  "unsafe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementation(async () => [() => { loader = fake; }] as never); vi.clearAllMocks(); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-global-lifecycle",
  "clearAllMocks preserves no-op implementation",
  "safe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementation(async () => [() => {}] as never); vi.clearAllMocks(); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-captured-provenance",
  "mockRestore returns to prior direct mutating implementation",
  "unsafe",
  supabaseLoader("Promise.all = async () => [() => { loader = fake; }] as never; const spy = vi.spyOn(Promise, 'all'); spy.mockImplementation(async () => [() => {}] as never); spy.mockRestore(); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-captured-provenance",
  "mockRestore returns to prior direct no-op implementation",
  "safe",
  supabaseLoader("Promise.all = async () => [() => {}] as never; const spy = vi.spyOn(Promise, 'all'); spy.mockImplementation(async () => [() => { loader = fake; }] as never); spy.mockRestore(); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-once-replacement",
  "direct assignment clears queued mutating implementation",
  "safe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementationOnce(async () => [() => { loader = fake; }] as never); Promise.all = async () => [() => {}] as never; const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-once-replacement",
  "direct assignment clears queue and installs mutating implementation",
  "unsafe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementationOnce(async () => [() => {}] as never); Promise.all = async () => [() => { loader = fake; }] as never; const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-once-preservation",
  "mockImplementation preserves queued mutating implementation",
  "unsafe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementationOnce(async () => [() => { loader = fake; }] as never); spy.mockImplementation(async () => [() => {}] as never); const actions = await Promise.all([() => {}]); for (const action of actions) action();"),
);
regress(
  "effects:promise-all-once-preservation",
  "mockImplementation preserves queued no-op implementation",
  "safe",
  supabaseLoader("const spy = vi.spyOn(Promise, 'all'); spy.mockImplementationOnce(async () => [() => {}] as never); spy.mockImplementation(async () => [() => { loader = fake; }] as never); const actions = await Promise.all([() => { loader = fake; }]); for (const action of actions) action();"),
);

regress(
  "sql:nested-locking-clause",
  "subquery FOR UPDATE is not read-only",
  "unsafe",
  pointerUnit,
  postgresTarget("const sql = postgres(DB_URL!);", "sql`SELECT id FROM (SELECT id FROM public.bookings FOR UPDATE) locked`"),
);
regress(
  "sql:nested-locking-clause",
  "CTE FOR SHARE is not read-only",
  "unsafe",
  pointerUnit,
  postgresTarget("const sql = postgres(DB_URL!);", "sql`WITH locked AS (SELECT id FROM public.bookings FOR SHARE) SELECT id FROM locked`"),
);
regress(
  "sql:nested-locking-clause",
  "nested read-only SELECT inverse",
  "safe",
  pointerUnit,
  postgresTarget("const sql = postgres(DB_URL!);", "sql`WITH visible AS (SELECT id FROM public.bookings) SELECT id FROM visible`"),
);

type ProvenanceCase = {
  shape: string;
  target: PostgresProvenanceTarget;
  resources: string[];
  sql: string;
  accepted: boolean;
};

const reviewedPolicy = "CREATE POLICY bookings_select_policy ON public.bookings\n" +
  "  FOR SELECT\n" +
  "  USING (auth_user_in_tenant(tenant_id));";
const provenanceCases: ProvenanceCase[] = [
  { shape: "ALTER ROUTINE policy dependency", target: "main", resources: ["table:public.bookings"], sql: "ALTER ROUTINE public.auth_user_in_tenant(uuid) SET search_path = private, public;", accepted: false },
  { shape: "comment-separated ALTER ROUTINE", target: "main", resources: ["table:public.bookings"], sql: "ALTER/*probe*/ ROUTINE public.auth_user_in_tenant(uuid) SET search_path = private, public;", accepted: false },
  { shape: "DROP ROUTINE RPC", target: "rag", resources: ["rpc:public.match_region_itinerary_chunks"], sql: "DROP ROUTINE public.match_region_itinerary_chunks(text[], text[], date, date, text[], integer);", accepted: false },
  { shape: "named DROP FUNCTION identity", target: "main", resources: ["table:public.bookings"], sql: "DROP FUNCTION public.auth_user_in_tenant(target_tenant_id uuid);", accepted: false },
  { shape: "qualified DROP FUNCTION identity", target: "main", resources: ["table:public.bookings"], sql: "DROP FUNCTION public.auth_user_in_tenant(pg_catalog.uuid);", accepted: false },
  { shape: "ARRAY and int DROP FUNCTION identities", target: "rag", resources: ["rpc:public.match_region_itinerary_chunks"], sql: "DROP FUNCTION public.match_region_itinerary_chunks(text ARRAY, text ARRAY, date, date, text ARRAY, int);", accepted: false },
  {
    shape: "policy OID rebound by session search_path",
    target: "main",
    resources: ["table:public.bookings"],
    sql: "CREATE SCHEMA private; " +
      "CREATE FUNCTION private.auth_user_in_tenant(target_tenant_id uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$; " +
      "SET search_path = private, public; DROP POLICY bookings_select_policy ON public.bookings; " + reviewedPolicy,
    accepted: false,
  },
  {
    shape: "policy OID rebound by default $user search_path",
    target: "main",
    resources: ["table:public.bookings"],
    sql: "CREATE SCHEMA postgres; " +
      "CREATE FUNCTION postgres.auth_user_in_tenant(target_tenant_id uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$; " +
      "DROP POLICY bookings_select_policy ON public.bookings; " + reviewedPolicy,
    accepted: false,
  },
  { shape: "operator plus persistent search_path", target: "main", resources: ["table:public.bookings"], sql: "CREATE OPERATOR public.= (LEFTARG = uuid, RIGHTARG = uuid, FUNCTION = pg_catalog.uuid_eq); ALTER ROLE authenticated SET search_path = public, pg_catalog;", accepted: false },
  { shape: "reviewed role SUPERUSER", target: "main", resources: ["table:public.bookings"], sql: "ALTER ROLE authenticated SUPERUSER;", accepted: false },
  { shape: "ALTER USER reviewed role BYPASSRLS", target: "main", resources: ["table:public.bookings"], sql: "ALTER USER authenticated WITH NOSUPERUSER BYPASSRLS;", accepted: false },
  { shape: "reviewed role authority restoration", target: "main", resources: ["table:public.bookings"], sql: "ALTER ROLE authenticated SUPERUSER BYPASSRLS; ALTER USER authenticated NOSUPERUSER NOBYPASSRLS;", accepted: true },
  { shape: "reviewed role second in drop list", target: "main", resources: ["table:public.bookings"], sql: "DROP ROLE reporting_user, authenticated;", accepted: false },
  { shape: "quoted role keyword remains literal", target: "main", resources: ["table:public.bookings"], sql: "ALTER ROLE \"CURRENT_USER\" BYPASSRLS;", accepted: true },
  { shape: "ALTER USER persistent path", target: "main", resources: ["table:public.bookings"], sql: "ALTER USER authenticated SET search_path = private, public;", accepted: false },
  { shape: "role-database path survives global role reset", target: "main", resources: ["table:public.bookings"], sql: "ALTER ROLE authenticated IN DATABASE postgres SET search_path = private, public; ALTER ROLE authenticated RESET search_path;", accepted: false },
  { shape: "database path survives other database reset", target: "main", resources: ["table:public.bookings"], sql: "ALTER DATABASE postgres SET search_path = private, public; ALTER DATABASE template1 RESET search_path;", accepted: false },
  { shape: "system path survives role-all reset", target: "main", resources: ["table:public.bookings"], sql: "ALTER SYSTEM SET search_path = private, public; ALTER ROLE ALL RESET search_path;", accepted: false },
  { shape: "role-all/database same-scope cleanup", target: "main", resources: ["table:public.bookings"], sql: "ALTER ROLE ALL IN DATABASE postgres SET search_path = private, public; ALTER DATABASE postgres RESET search_path;", accepted: true },
  {
    shape: "$user follows SET ROLE for index binding",
    target: "main",
    resources: ["table:public.bookings"],
    sql: "CREATE ROLE private_creator; CREATE SCHEMA private_creator; " +
      "CREATE OPERATOR CLASS private_creator.evil_uuid_ops FOR TYPE uuid USING btree AS " +
      "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
      "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
      "SET ROLE private_creator; SET search_path = \"$user\", public; " +
      "CREATE INDEX bookings_identity_probe ON public.bookings USING btree (id evil_uuid_ops);",
    accepted: false,
  },
  { shape: "UUID equality implementation replacement", target: "main", resources: ["table:public.bookings"], sql: "CREATE OR REPLACE FUNCTION pg_catalog.uuid_eq(uuid, uuid) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT false $$;", accepted: false },
  { shape: "UUID equality attribute alteration", target: "main", resources: ["table:public.bookings"], sql: "ALTER FUNCTION pg_catalog.uuid_eq(uuid, uuid) LEAKPROOF;", accepted: false },
  { shape: "unqualified UUID comparison alteration", target: "main", resources: ["table:public.bookings"], sql: "ALTER FUNCTION uuid_cmp(uuid, uuid) NOT LEAKPROOF;", accepted: false },
  { shape: "UUID equality implementation drop", target: "main", resources: ["table:public.bookings"], sql: "DROP FUNCTION pg_catalog.uuid_eq(uuid, uuid) CASCADE;", accepted: false },
  { shape: "unqualified UUID equality drop", target: "main", resources: ["table:public.bookings"], sql: "DROP FUNCTION uuid_eq(uuid, uuid) CASCADE;", accepted: false },
  { shape: "creation-path UUID equality replacement", target: "main", resources: ["table:public.bookings"], sql: "SET search_path = pg_catalog, public; CREATE OR REPLACE FUNCTION uuid_eq(uuid, uuid) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT false $$;", accepted: false },
  { shape: "UUID comparison support replacement", target: "main", resources: ["table:public.bookings"], sql: "CREATE OR REPLACE FUNCTION pg_catalog.uuid_cmp(uuid, uuid) RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT 0 $$;", accepted: false },
  { shape: "UUID comparison support drop", target: "main", resources: ["table:public.bookings"], sql: "DROP FUNCTION pg_catalog.uuid_cmp(uuid, uuid) CASCADE;", accepted: false },
  { shape: "text equality alteration", target: "main", resources: ["table:public.bookings"], sql: "ALTER FUNCTION pg_catalog.texteq(text, text) NOT LEAKPROOF;", accepted: false },
  { shape: "case-insensitive text comparison drop", target: "rag", resources: ["table:public.knowledge_chunks", "rpc:public.match_region_itinerary_chunks"], sql: "DROP FUNCTION pg_catalog.texticlike(text, text) CASCADE;", accepted: false },
  { shape: "date equality alteration", target: "rag", resources: ["table:public.knowledge_chunks", "rpc:public.match_region_itinerary_chunks"], sql: "ALTER FUNCTION pg_catalog.date_eq(date, date) VOLATILE;", accepted: false },
  { shape: "UUID sort-support alteration", target: "main", resources: ["table:public.bookings"], sql: "ALTER FUNCTION pg_catalog.uuid_sortsupport(internal) PARALLEL RESTRICTED;", accepted: false },
  { shape: "btree equality-image drop", target: "main", resources: ["table:public.bookings"], sql: "DROP FUNCTION pg_catalog.btequalimage(oid) CASCADE;", accepted: false },
  { shape: "unknown catalog routine creation", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION pg_catalog.unknown_guard_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;", accepted: false },
  { shape: "quoted catalog procedure replacement", target: "main", resources: ["table:public.bookings"], sql: "CREATE OR REPLACE PROCEDURE \"pg_catalog\".unknown_guard_procedure() LANGUAGE sql AS $$ SELECT 1 $$;", accepted: false },
  { shape: "catalog aggregate creation", target: "main", resources: ["table:public.bookings"], sql: "CREATE AGGREGATE pg_catalog.unknown_guard_aggregate(integer) (SFUNC = pg_catalog.int4pl, STYPE = integer);", accepted: false },
  { shape: "catalog creation through SET SCHEMA", target: "main", resources: ["table:public.bookings"], sql: "SET SCHEMA 'pg_catalog'; CREATE FUNCTION unknown_guard_path_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;", accepted: false },
  { shape: "catalog destination schema", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.unknown_guard_move_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$; ALTER FUNCTION public.unknown_guard_move_probe() SET SCHEMA pg_catalog;", accepted: false },
  { shape: "catalog procedure second in drop list", target: "main", resources: ["table:public.bookings"], sql: "DROP PROCEDURE public.unrelated(), pg_catalog.unknown_guard_procedure() CASCADE;", accepted: false },
  { shape: "extension catalog routine membership", target: "main", resources: ["table:public.bookings"], sql: "ALTER EXTENSION plpgsql DROP FUNCTION pg_catalog.unknown_guard_probe();", accepted: false },
  { shape: "synthetic UUID equality reconstruction", target: "main", resources: ["table:public.bookings"], sql: "CREATE OR REPLACE FUNCTION pg_catalog.uuid_eq(uuid, uuid) RETURNS boolean AS 'uuid_eq' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;", accepted: false },
  { shape: "synthetic UUID comparison reconstruction", target: "main", resources: ["table:public.bookings"], sql: "CREATE OR REPLACE FUNCTION pg_catalog.uuid_cmp(uuid, uuid) RETURNS integer AS 'uuid_cmp' LANGUAGE internal IMMUTABLE STRICT PARALLEL SAFE;", accepted: false },
  { shape: "UUID equality second in drop list", target: "main", resources: ["table:public.bookings"], sql: "DROP FUNCTION public.unrelated(), pg_catalog.uuid_eq(uuid, uuid) CASCADE;", accepted: false },
  { shape: "reviewed operator second in drop list", target: "main", resources: ["table:public.bookings"], sql: "DROP OPERATOR public.## (uuid, uuid), pg_catalog.= (uuid, uuid) CASCADE;", accepted: false },
  { shape: "reviewed index second in drop list", target: "main", resources: ["table:public.bookings"], sql: "DROP INDEX public.unrelated_idx, public.bookings_pkey CASCADE;", accepted: false },
  { shape: "unrelated public routine replacement", target: "main", resources: ["table:public.bookings"], sql: "CREATE OR REPLACE FUNCTION public.catalog_name_probe(bigint, bigint) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT $1 = $2 $$;", accepted: true },
  { shape: "unrelated private routine creation", target: "main", resources: ["table:public.bookings"], sql: "CREATE SCHEMA private; CREATE FUNCTION private.catalog_name_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;", accepted: true },
  { shape: "unrelated public routine lifecycle", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.catalog_lifecycle_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$; ALTER FUNCTION public.catalog_lifecycle_probe() VOLATILE; DROP FUNCTION public.catalog_lifecycle_probe();", accepted: true },
  { shape: "private-path routine creation", target: "main", resources: ["table:public.bookings"], sql: "CREATE SCHEMA private; SET search_path = private, public; CREATE FUNCTION catalog_path_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;", accepted: true },
  {
    shape: "created operator class reaches reviewed index",
    target: "main",
    resources: ["table:public.bookings"],
    sql: "CREATE OPERATOR CLASS public.uuid_ops DEFAULT FOR TYPE uuid USING btree AS " +
      "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
      "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
      "CREATE INDEX bookings_uuid_ops_probe ON public.bookings USING btree (id public.uuid_ops);",
    accepted: false,
  },
  {
    shape: "comment-separated CREATE operator class reaches reviewed index",
    target: "main",
    resources: ["table:public.bookings"],
    sql: "CREATE/*probe*/ OPERATOR CLASS public.evil_uuid_ops FOR TYPE uuid USING btree AS " +
      "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
      "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
      "CREATE INDEX bookings_uuid_ops_probe ON public.bookings USING btree (id public.evil_uuid_ops);",
    accepted: false,
  },
  {
    shape: "created access method reaches reviewed index",
    target: "main",
    resources: ["table:public.bookings"],
    sql: "CREATE ACCESS METHOD evil TYPE INDEX HANDLER pg_catalog.bthandler; " +
      "CREATE INDEX bookings_evil_probe ON public.bookings USING evil (id);",
    accepted: false,
  },
  {
    shape: "temporary search_path binds private opclass to reviewed index",
    target: "main",
    resources: ["table:public.bookings"],
    sql: "CREATE SCHEMA private; " +
      "CREATE OPERATOR CLASS private.evil_uuid_ops FOR TYPE uuid USING btree AS " +
      "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
      "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
      "SET search_path = private, public; " +
      "CREATE INDEX bookings_private_ops_probe ON public.bookings USING btree (id evil_uuid_ops); " +
      "RESET search_path;",
    accepted: false,
  },
  {
    shape: "no-space SET LOCAL binds private opclass to reviewed index",
    target: "main",
    resources: ["table:public.bookings"],
    sql: "CREATE SCHEMA private; " +
      "CREATE OPERATOR CLASS private.evil_uuid_ops FOR TYPE uuid USING btree AS " +
      "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
      "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
      "SET LOCAL search_path=private,public; " +
      "CREATE INDEX bookings_private_ops_probe ON public.bookings USING btree (id evil_uuid_ops);",
    accepted: false,
  },
  {
    shape: "comment-separated SET binds private opclass to reviewed index",
    target: "main",
    resources: ["table:public.bookings"],
    sql: "CREATE SCHEMA private; " +
      "CREATE OPERATOR CLASS private.evil_uuid_ops FOR TYPE uuid USING btree AS " +
      "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
      "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
      "SET/*probe*/ search_path=private,public; " +
      "CREATE INDEX bookings_private_ops_probe ON public.bookings USING btree (id evil_uuid_ops);",
    accepted: false,
  },
  {
    shape: "SET SCHEMA binds private opclass to reviewed index",
    target: "main",
    resources: ["table:public.bookings"],
    sql: "CREATE SCHEMA private; " +
      "CREATE OPERATOR CLASS private.evil_uuid_ops FOR TYPE uuid USING btree AS " +
      "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
      "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
      "SET SCHEMA 'private'; " +
      "CREATE INDEX bookings_private_ops_probe ON public.bookings USING btree (id evil_uuid_ops);",
    accepted: false,
  },
  {
    shape: "implicit pg_catalog binds created opclass to reviewed index",
    target: "main",
    resources: ["table:public.bookings"],
    sql: "CREATE OPERATOR CLASS pg_catalog.evil_uuid_ops FOR TYPE uuid USING btree AS " +
      "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
      "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
      "CREATE INDEX bookings_pg_catalog_ops_probe ON public.bookings USING btree (id evil_uuid_ops);",
    accepted: false,
  },
  { shape: "reviewed column type mutation", target: "main", resources: ["table:public.bookings"], sql: "ALTER TABLE public.bookings ALTER COLUMN id TYPE text USING id::text;", accepted: false },
  { shape: "comment-separated reviewed RLS mutation", target: "main", resources: ["table:public.bookings"], sql: "ALTER/*probe*/ TABLE public.bookings DISABLE ROW LEVEL SECURITY;", accepted: false },
  { shape: "relevant cast removal", target: "main", resources: ["table:public.bookings"], sql: "DROP CAST (uuid AS text);", accepted: false },
  { shape: "built-in type shadow", target: "main", resources: ["table:public.bookings"], sql: "CREATE DOMAIN public.uuid AS text;", accepted: false },
  { shape: "unreviewed extension", target: "main", resources: ["table:public.bookings"], sql: "CREATE EXTENSION IF NOT EXISTS hstore;", accepted: false },
  { shape: "extension create/drop laundering", target: "main", resources: ["table:public.bookings"], sql: "CREATE EXTENSION IF NOT EXISTS hstore; DROP EXTENSION hstore;", accepted: false },
  { shape: "catalog-schema extension laundering", target: "main", resources: ["table:public.bookings"], sql: "CREATE EXTENSION hstore SCHEMA pg_catalog; DROP EXTENSION hstore;", accepted: false },
  { shape: "catalog extension drop/recreate/drop laundering", target: "main", resources: ["table:public.bookings"], sql: "DROP EXTENSION plpgsql CASCADE; CREATE EXTENSION plpgsql; DROP EXTENSION plpgsql CASCADE;", accepted: false },
  { shape: "dynamic catalog DDL in DO", target: "main", resources: ["table:public.bookings"], sql: "DO $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$;", accepted: false },
  { shape: "called procedure with dynamic catalog DDL", target: "main", resources: ["table:public.bookings"], sql: "CREATE PROCEDURE public.catalog_mutator() LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$; CALL public.catalog_mutator();", accepted: false },
  { shape: "selected function with dynamic catalog DDL", target: "rag", resources: ["table:public.knowledge_chunks", "rpc:public.match_region_itinerary_chunks"], sql: "CREATE FUNCTION public.catalog_mutator() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$; SELECT public.catalog_mutator();", accepted: false },
  { shape: "dynamic catalog DDL in a standard single-quoted body", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.quoted_mutator() RETURNS integer LANGUAGE plpgsql AS 'BEGIN EXECUTE ''CREATE FUNCTION pg_catalog.quoted_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$''; RETURN 1; END'; SELECT public.quoted_mutator();", accepted: false },
  { shape: "dynamic catalog DDL through a standard single-quoted wrapper", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.catalog_mutator() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN 1; END $body$; CREATE FUNCTION public.quoted_wrapper() RETURNS integer LANGUAGE sql AS 'SELECT public.catalog_mutator()'; SELECT public.quoted_wrapper();", accepted: false },
  { shape: "invoked unanalysable escape-string body", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.escape_body() RETURNS integer LANGUAGE plpgsql AS E'BEGIN RETURN 1; END'; SELECT public.escape_body();", accepted: false },
  { shape: "dynamic wrapper dependency after callee recreation", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.rebound_mutator() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.rebound_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN 1; END $body$; CREATE FUNCTION public.rebound_wrapper() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN public.rebound_mutator(); END $$; DROP FUNCTION public.rebound_mutator(); CREATE FUNCTION public.rebound_mutator() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.rebound_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN 1; END $body$; SELECT public.rebound_wrapper();", accepted: false },
  { shape: "wrong-signature private shadow before catalog ALTER", target: "main", resources: ["table:public.bookings"], sql: "CREATE SCHEMA private; SET search_path=private,pg_catalog; CREATE FUNCTION private.uuid_eq(integer, integer) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$; ALTER FUNCTION uuid_eq(uuid, uuid) VOLATILE;", accepted: false },
  { shape: "wrong-signature private shadow before catalog DROP", target: "main", resources: ["table:public.bookings"], sql: "CREATE SCHEMA private; SET search_path=private,pg_catalog; CREATE FUNCTION private.uuid_eq(integer, integer) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$; DROP FUNCTION uuid_eq(uuid, uuid);", accepted: false },
  { shape: "dynamic catalog DDL through SELECT FROM", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.catalog_mutator() RETURNS SETOF integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN NEXT 1; END $body$; SELECT * FROM public.catalog_mutator();", accepted: false },
  { shape: "dynamic catalog DDL through SELECT predicate", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.catalog_mutator() RETURNS boolean LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN true; END $body$; SELECT 1 WHERE public.catalog_mutator();", accepted: false },
  { shape: "dynamic catalog DDL through quoted routine call", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.catalog_mutator() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$; SELECT public.\"catalog_mutator\"();", accepted: false },
  { shape: "dynamic catalog DDL through INSERT SELECT", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.catalog_mutator() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN 1; END $body$; CREATE TABLE public.probe_sink(value integer); INSERT INTO public.probe_sink SELECT public.catalog_mutator();", accepted: false },
  { shape: "dynamic catalog DDL through UPDATE", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.catalog_mutator() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN 1; END $body$; CREATE TABLE public.probe_sink(value integer); UPDATE public.probe_sink SET value = public.catalog_mutator();", accepted: false },
  { shape: "dynamic catalog DDL through CREATE TABLE AS", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.catalog_mutator() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN 1; END $body$; CREATE TABLE public.probe_sink AS SELECT public.catalog_mutator() AS value;", accepted: false },
  { shape: "dynamic catalog DDL through transitive wrapper", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.catalog_mutator() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN 1; END $body$; CREATE FUNCTION public.catalog_wrapper() RETURNS integer LANGUAGE sql AS $$ SELECT public.catalog_mutator() $$; SELECT public.catalog_wrapper();", accepted: false },
  { shape: "Unicode-delimited reviewed relation", target: "main", resources: ["table:public.bookings"], sql: "ALTER TABLE U&\"publ\\0069c\".bookings DISABLE ROW LEVEL SECURITY;", accepted: false },
  { shape: "Unicode-delimited reviewed role", target: "main", resources: ["table:public.bookings"], sql: "ALTER USER U&\"authent\\0069cated\" SET search_path = private, pg_catalog, public;", accepted: false },
  { shape: "Unicode-delimited catalog operator", target: "main", resources: ["table:public.bookings"], sql: "DROP OPERATOR U&\"pg\\005fcatalog\".= (uuid, uuid) CASCADE;", accepted: false },
  { shape: "Unicode-delimited reviewed index", target: "main", resources: ["table:public.bookings"], sql: "DROP INDEX U&\"publ\\0069c\".bookings_pkey CASCADE;", accepted: false },
  { shape: "dynamic function after rename", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.catalog_mutator() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$; ALTER FUNCTION public.catalog_mutator() RENAME TO renamed_catalog_mutator; SELECT public.renamed_catalog_mutator();", accepted: false },
  { shape: "dynamic procedure after schema move", target: "main", resources: ["table:public.bookings"], sql: "CREATE SCHEMA private; CREATE PROCEDURE public.catalog_mutator() LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$; ALTER PROCEDURE public.catalog_mutator() SET SCHEMA private; CALL private.catalog_mutator();", accepted: false },
  { shape: "vector drop/recreation laundering", target: "rag", resources: ["table:public.knowledge_chunks", "rpc:public.match_region_itinerary_chunks"], sql: "DROP EXTENSION vector CASCADE; CREATE EXTENSION IF NOT EXISTS vector;", accepted: false },
  { shape: "vector alteration/drop/recreation laundering", target: "rag", resources: ["table:public.knowledge_chunks", "rpc:public.match_region_itinerary_chunks"], sql: "ALTER EXTENSION vector UPDATE; DROP EXTENSION vector CASCADE; CREATE EXTENSION IF NOT EXISTS vector;", accepted: false },
  { shape: "pg_trgm drop/recreation laundering", target: "rag", resources: ["table:public.knowledge_chunks", "rpc:public.match_region_itinerary_chunks"], sql: "DROP EXTENSION pg_trgm CASCADE; CREATE EXTENSION IF NOT EXISTS pg_trgm;", accepted: false },
  { shape: "reviewed schema rename", target: "main", resources: ["table:public.bookings"], sql: "ALTER SCHEMA public RENAME TO app_public;", accepted: false },
  { shape: "reviewed operator family", target: "main", resources: ["table:public.bookings"], sql: "ALTER OPERATOR FAMILY pg_catalog.uuid_ops USING btree ADD OPERATOR 1 pg_catalog.= (uuid, uuid);", accepted: false },
  { shape: "unrelated table ALTER", target: "main", resources: ["table:public.bookings"], sql: "CREATE TABLE public.other_rows (id uuid); ALTER TABLE public.other_rows ALTER COLUMN id TYPE text USING id::text;", accepted: true },
  { shape: "unrelated role search_path", target: "main", resources: ["table:public.bookings"], sql: "ALTER ROLE reporting_user SET search_path = private, public;", accepted: true },
  { shape: "operator effective cleanup", target: "main", resources: ["table:public.bookings"], sql: "CREATE OPERATOR public.## (LEFTARG = uuid, RIGHTARG = uuid, FUNCTION = pg_catalog.uuid_eq); DROP OPERATOR public.## (uuid, uuid);", accepted: true },
  { shape: "proven private routine ALTER", target: "main", resources: ["table:public.bookings"], sql: "CREATE SCHEMA private; SET search_path=private,pg_catalog; CREATE FUNCTION f() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$; ALTER FUNCTION f() VOLATILE;", accepted: true },
  { shape: "proven private routine DROP", target: "main", resources: ["table:public.bookings"], sql: "CREATE SCHEMA private; SET search_path=private,pg_catalog; CREATE FUNCTION f() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$; DROP FUNCTION f();", accepted: true },
  { shape: "proven private exact overload ALTER", target: "main", resources: ["table:public.bookings"], sql: "CREATE SCHEMA private; SET search_path=private,pg_catalog; CREATE FUNCTION f() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$; CREATE FUNCTION f(integer) RETURNS integer LANGUAGE sql AS $$ SELECT $1 $$; ALTER FUNCTION f() VOLATILE;", accepted: true },
  { shape: "proven private exact overload DROP", target: "main", resources: ["table:public.bookings"], sql: "CREATE SCHEMA private; SET search_path=private,pg_catalog; CREATE FUNCTION f() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$; CREATE FUNCTION f(integer) RETURNS integer LANGUAGE sql AS $$ SELECT $1 $$; DROP FUNCTION f();", accepted: true },
  { shape: "uninvoked dynamic routine", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.catalog_mutator() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$; SELECT COALESCE(1, 1);", accepted: true },
  { shape: "safe standard single-quoted body", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.quoted_safe() RETURNS integer LANGUAGE plpgsql AS 'BEGIN RETURN 1; END'; SELECT public.quoted_safe();", accepted: true },
  { shape: "literal text in a standard single-quoted body", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.quoted_literal() RETURNS text LANGUAGE plpgsql AS 'BEGIN RETURN ''EXECUTE public.fake()''; END'; SELECT public.quoted_literal();", accepted: true },
  { shape: "uninvoked unanalysable escape-string body", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.escape_body() RETURNS integer LANGUAGE plpgsql AS E'BEGIN RETURN 1; END'; SELECT 1;", accepted: true },
  { shape: "safe callee recreation behind a wrapper", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.rebound_mutator() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'SELECT 1'; RETURN 1; END $$; CREATE FUNCTION public.rebound_wrapper() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN public.rebound_mutator(); END $$; DROP FUNCTION public.rebound_mutator(); CREATE FUNCTION public.rebound_mutator() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$; SELECT public.rebound_wrapper();", accepted: true },
  { shape: "safe wrapper and callee recreation", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.rebound_mutator() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$; CREATE FUNCTION public.rebound_wrapper() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN public.rebound_mutator(); END $$; DROP FUNCTION public.rebound_mutator(); CREATE FUNCTION public.rebound_mutator() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN 2; END $$; SELECT public.rebound_wrapper();", accepted: true },
  { shape: "call-shaped quoted alias", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.catalog_mutator() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$; SELECT 1 AS \"public.catalog_mutator()\";", accepted: true },
  { shape: "qualified call-shaped quoted column", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.catalog_mutator() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$; SELECT x.\"public.catalog_mutator()\" FROM (SELECT 1 AS \"public.catalog_mutator()\") x;", accepted: true },
  { shape: "unqualified call-shaped quoted alias", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.catalog_mutator() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$; SELECT 1 AS \"catalog_mutator()\";", accepted: true },
  { shape: "escaped call-shaped quoted alias", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.catalog_mutator() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; END $body$; SELECT 1 AS \"public.catalog_mutator()\"\"quoted\";", accepted: true },
  { shape: "unrelated wrapper around a dynamic routine", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.catalog_mutator() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN 1; END $body$; CREATE FUNCTION public.safe_wrapper() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$; SELECT public.safe_wrapper();", accepted: true },
  { shape: "unrelated INSERT and UPDATE expressions", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.catalog_mutator() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN 1; END $body$; CREATE TABLE public.probe_sink(value integer); INSERT INTO public.probe_sink SELECT COALESCE(1, 1); UPDATE public.probe_sink SET value = COALESCE(value, 1);", accepted: true },
  { shape: "call-shaped CTAS literals", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.catalog_mutator() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE $ddl$CREATE FUNCTION pg_catalog.catalog_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$ $ddl$; RETURN 1; END $body$; CREATE TABLE public.probe_sink AS SELECT 'public.catalog_mutator()'::text AS value;", accepted: true },
  { shape: "inert Unicode-delimited identifier text", target: "main", resources: ["table:public.bookings"], sql: "SELECT 'ALTER TABLE U&\"publ\\0069c\".bookings'; SELECT $$ DROP INDEX U&\"publ\\0069c\".bookings_pkey $$; -- ALTER USER U&\"authent\\0069cated\" SET search_path=private;", accepted: true },
  { shape: "renamed schema remains in creation path", target: "main", resources: ["table:public.bookings"], sql: "CREATE SCHEMA private; ALTER SCHEMA private RENAME TO private2; SET search_path=private2,pg_catalog; CREATE FUNCTION f() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;", accepted: true },
  { shape: "other-database role path", target: "main", resources: ["table:public.bookings"], sql: "ALTER ROLE authenticated IN DATABASE template1 SET search_path=private,public;", accepted: true },
  { shape: "private same-name index drop", target: "main", resources: ["table:public.bookings"], sql: "CREATE SCHEMA private; CREATE TABLE private.other(id uuid); CREATE INDEX bookings_pkey ON private.other(id); SET search_path=private,public; DROP INDEX bookings_pkey;", accepted: true },
  { shape: "unused created access method", target: "main", resources: ["table:public.bookings"], sql: "CREATE ACCESS METHOD evil TYPE INDEX HANDLER pg_catalog.bthandler;", accepted: true },
  {
    shape: "unused private operator class",
    target: "main",
    resources: ["table:public.bookings"],
    sql: "CREATE SCHEMA private; CREATE OPERATOR CLASS private.uuid_ops FOR TYPE uuid USING btree AS " +
      "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
      "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid);",
    accepted: true,
  },
  {
    shape: "unused pg_catalog operator class",
    target: "main",
    resources: ["table:public.bookings"],
    sql: "CREATE OPERATOR CLASS pg_catalog.evil_uuid_ops FOR TYPE uuid USING btree AS " +
      "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
      "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid);",
    accepted: true,
  },
  {
    shape: "implicit pg_catalog built-in wins before private shadow",
    target: "main",
    resources: ["table:public.bookings"],
    sql: "CREATE SCHEMA private; CREATE OPERATOR CLASS private.uuid_ops FOR TYPE uuid USING btree AS " +
      "OPERATOR 1 pg_catalog.< (uuid, uuid), OPERATOR 3 pg_catalog.= (uuid, uuid), " +
      "OPERATOR 5 pg_catalog.> (uuid, uuid), FUNCTION 1 pg_catalog.uuid_cmp(uuid, uuid); " +
      "SET search_path = private, public; " +
      "CREATE INDEX bookings_builtin_shadow_probe ON public.bookings USING btree (id uuid_ops);",
    accepted: true,
  },
  { shape: "catalog text inside dollar body", target: "main", resources: ["table:public.bookings"], sql: "CREATE FUNCTION public.inert_catalog_text() RETURNS text LANGUAGE sql AS $$ SELECT 'DROP OWNED BY authenticated' $$;", accepted: true },
];

const repoMigrations = new Map<PostgresProvenanceTarget, { file: string; sql: string }[]>();
function provenanceFor(target: PostgresProvenanceTarget, sql: string) {
  let migrations = repoMigrations.get(target);
  if (!migrations) {
    const dir = path.join(process.cwd(), "apps", target, "supabase", "migrations");
    migrations = readdirSync(dir)
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => ({ file, sql: readFileSync(path.join(dir, file), "utf8") }));
    repoMigrations.set(target, migrations);
  }
  return derivePostgresMigrationProvenance([...migrations, { file: "zzzz_census.sql", sql }]);
}

describe("mocked-tenant flow/effect census", () => {
  it("retains the complete 137-case acceptance matrix", () => {
    expect(rows).toHaveLength(137);
  });

  it.each(rows)("$family — $shape", ({ intent, verdict, detail }) => {
    expect(verdict, detail).toBe(intent === "safe" ? "ACCEPT" : "REJECT");
  });

  it.each(regressions)("regression: $family — $shape", ({ intent, verdict, detail }) => {
    expect(verdict, detail).toBe(intent === "safe" ? "ACCEPT" : "REJECT");
  });

  it.each(provenanceCases)("provenance: $shape", ({ target, resources, sql, accepted }) => {
    expect(postgresResourcesMatchReviewedProvenance(target, resources, provenanceFor(target, sql)))
      .toBe(accepted);
  });
});
