// Unit tests — mocked-tenant-test guard (Harvey Tier-1 port, refs #2028).
// Intent: a test that CLAIMS isolation coverage while mocking the Supabase
// client can never observe an RLS regression — the guard must catch that
// combination and ONLY that combination (mock without claim, claim without
// mock, and partial mocks must all stay silent).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findMockedTenantTests, loadBaseline, walk } from "../../../scripts/check-mocked-tenant-tests";

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

const annotationErrorFor = (coverageTarget: string): string | undefined => {
  const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
    '  it("enforces tenant isolation on the list query", async () => {});',
    `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
  );
  return findMockedTenantTests(F, source, new Map([[RLS_FILE, coverageTarget]]))[0]?.annotationError;
};

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
