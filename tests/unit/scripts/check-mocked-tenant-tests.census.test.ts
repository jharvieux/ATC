import { describe, expect, it } from "vitest";
import { findMockedTenantTests } from "../../../scripts/check-mocked-tenant-tests";

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
});
