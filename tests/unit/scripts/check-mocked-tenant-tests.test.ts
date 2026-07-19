// Unit tests — mocked-tenant-test guard (Harvey Tier-1 port, refs #2028).
// Intent: a test that CLAIMS isolation coverage while mocking the Supabase
// client can never observe an RLS regression — the guard must catch that
// combination and ONLY that combination (mock without claim, claim without
// mock, and partial mocks must all stay silent).
import { describe, it, expect } from "vitest";
import { findMockedTenantTests, loadBaseline } from "../../../scripts/check-mocked-tenant-tests";

const F = "apps/main/test/unit/notes.test.ts";
const EMPTY = new Map<string, string>();

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
});

describe("loadBaseline", () => {
  it("returns an empty map for a missing file (fail-closed)", () => {
    expect(loadBaseline("/nonexistent/mocked-baseline-2028.txt")).toEqual(new Map());
  });
});
