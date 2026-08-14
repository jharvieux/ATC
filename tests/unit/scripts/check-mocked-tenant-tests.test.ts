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

const claimTest = (body: string) => `
import { describe, it, vi } from "vitest";
${body}
describe("notes route", () => {
  it("enforces tenant isolation on the list query", async () => {});
});
`;

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

  it("rejects a coverage target that mocks the canonical witness", () => {
    const source = claimTest(`vi.mock("@supabase/supabase-js");`).replace(
      '  it("enforces tenant isolation on the list query", async () => {});',
      `  ${pointer()}\n  it("enforces tenant isolation on the list query", async () => {});`,
    );
    const mockedCoverage = `${REAL_DB_COVERAGE}\nvi.mock("../../../../tests/helpers/isolation-witness");`;
    const result = findMockedTenantTests(F, source, new Map([[RLS_FILE, mockedCoverage]]));
    expect(result[0]?.annotationError).toMatch(/mocks the canonical isolation witness/);
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
