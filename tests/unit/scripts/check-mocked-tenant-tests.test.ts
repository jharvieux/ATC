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
