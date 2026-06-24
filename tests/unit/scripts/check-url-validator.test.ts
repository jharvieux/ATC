// #1393/G2 — unit tests for the URL-validator guard's matcher.
//
// Pins what counts as a violation (a bare z.string().url() in code) vs. what
// must NOT (comments). A regression would either miss a new unsafe URL field
// (false negative) or flag a doc comment (false positive).

import { describe, it, expect } from "vitest";
import { findUrlValidators } from "../../../scripts/check-url-validator";

describe("findUrlValidators", () => {
  it("flags a bare z.string().url() in code", () => {
    const hits = findUrlValidators("apps/main/src/x/route.ts", `  image_url: z.string().url().optional(),`);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.key).toBe("apps/main/src/x/route.ts:1");
  });

  it("does not flag safeUrl usage", () => {
    expect(findUrlValidators("r.ts", `  image_url: safeUrl.optional(),`)).toEqual([]);
  });

  it("skips commented-out / doc references", () => {
    expect(findUrlValidators("r.ts", `// replaces a bare z.string().url(), whose new URL() ...`)).toEqual([]);
    expect(findUrlValidators("r.ts", `   * z.string().url() in a jsdoc block`)).toEqual([]);
  });

  it("reports line numbers per occurrence", () => {
    const src = ["const z = 1;", "a: z.string().url(),", "b: safeUrl,", "c: z.string().url(),"].join("\n");
    const hits = findUrlValidators("r.ts", src);
    expect(hits.map((h) => h.key)).toEqual(["r.ts:2", "r.ts:4"]);
  });

  it("counts two occurrences on the same line (matchAll, not test/g)", () => {
    const hits = findUrlValidators("r.ts", `a: z.string().url(), b: z.string().url(),`);
    expect(hits.map((h) => h.key)).toEqual(["r.ts:1", "r.ts:1"]);
  });
});
