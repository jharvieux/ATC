import { describe, it, expect } from "vitest";
import { join } from "path";
import { enumeratePageRoutes } from "../e2e/_enumerate-admin-pages";

// Unit-locks the page-route enumerator that drives the unauthenticated admin
// probe (tests/e2e/admin-pages-unauth.spec.ts, security issue #559).
//
// Why this matters beyond "it parses paths": the probe asserts a 404 on every
// admin page. If a probe URL is constructed wrong — a route group left in, or a
// [param] sent literally — the page 404s for the WRONG reason (no such route)
// and the probe passes while proving nothing. That false-pass-via-404 is the
// exact failure mode of the cross-tenant probe URL bug (#563). These assertions
// encode the two invariants that keep the probe honest.

const APP_DIR = join(process.cwd(), "apps", "main", "src", "app");
const routes = enumeratePageRoutes(APP_DIR, "(admin)");

describe("enumeratePageRoutes — (admin) subtree", () => {
  it("finds the admin page surface (non-empty, includes known pages)", () => {
    const urls = routes.map((r) => r.urlPath);
    expect(urls).toContain("/admin");
    expect(urls).toContain("/supervisor");
    // Floor just under the live count (19) so a partial-walk regression trips
    // it; lower deliberately if an admin page is removed. Kept in sync with the
    // e2e probe's self-test.
    expect(routes.length).toBeGreaterThanOrEqual(17);
  });

  it("strips route groups — no '(group)' leaks into any URL", () => {
    for (const r of routes) {
      expect(r.urlPath).not.toMatch(/[()]/);
      expect(r.probePath).not.toMatch(/[()]/);
    }
  });

  it("substitutes a concrete sentinel for dynamic segments in probePath", () => {
    const dynamic = routes.filter((r) => r.hasParam);
    // The (admin) tree has at least one dynamic page ([tenant_id]); if that ever
    // becomes zero this assertion fails loudly rather than vacuously passing.
    expect(dynamic.length).toBeGreaterThanOrEqual(1);
    for (const r of dynamic) {
      expect(r.urlPath).toMatch(/\[[^\]]+\]/); // bracketed in the URL form
      expect(r.probePath).not.toMatch(/[[\]]/); // no brackets in the probe form
      expect(r.probePath).toContain("00000000-0000-0000-0000-000000000000");
    }
  });

  it("leaves static pages' probePath identical to urlPath", () => {
    for (const r of routes.filter((x) => !x.hasParam)) {
      expect(r.probePath).toBe(r.urlPath);
    }
  });
});
