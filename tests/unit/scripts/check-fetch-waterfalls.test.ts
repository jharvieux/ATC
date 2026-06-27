// Unit tests — fetch-waterfall detector (M9). Intent: flag independent sequential
// awaits (parallelizable) without false-flagging a dependent chain or client code.
import { describe, it, expect } from "vitest";
import { findWaterfalls } from "../../../scripts/check-fetch-waterfalls";

const F = "apps/main/src/app/x/page.tsx";

describe("findWaterfalls", () => {
  it("flags two independent consecutive awaits", () => {
    const r = findWaterfalls(F, `const a = await getTeams();\nconst b = await getProjects();`);
    expect(r).toHaveLength(1);
    expect(r[0]!.independentAwaits).toBe(2);
  });

  it("does NOT flag a dependent chain (b uses a)", () => {
    expect(findWaterfalls(F, `const a = await getUser();\nconst b = await getOrg(a.orgId);`)).toEqual([]);
  });

  it("ignores 'use client' files", () => {
    expect(findWaterfalls(F, `'use client'\nconst a = await x();\nconst b = await y();`)).toEqual([]);
  });

  it("ignores test files and non-ts", () => {
    expect(findWaterfalls("apps/main/src/x.test.ts", `const a = await x();\nconst b = await y();`)).toEqual([]);
    expect(findWaterfalls("apps/main/src/x.css", `const a = await x();\nconst b = await y();`)).toEqual([]);
  });

  it("does not flag a single await", () => {
    expect(findWaterfalls(F, `const a = await x();`)).toEqual([]);
  });
});
