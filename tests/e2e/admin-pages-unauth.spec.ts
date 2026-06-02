import { test, expect } from "@playwright/test";
import { join } from "path";
import { enumeratePageRoutes } from "./_enumerate-admin-pages";

// Phase 1 — unauthenticated privileged-page probe (security issue #559).
//
// Every page in the (admin) route group server-renders behind two gates: the
// proxy host/cookie check (proxy.ts §26) and the authoritative
// assertPlatformAdmin check ((admin)/layout.tsx). An anonymous visitor — no
// session cookie, no Bearer, no test bypass — must get notFound() (404) from
// EVERY admin page. Never rendered admin content, and never a redirect that
// would itself confirm the surface exists.
//
// The probe enumerates the (admin) tree from the filesystem, so a newly-added
// admin page is covered automatically. That closes the exact failure mode #559
// was: a page added to the privileged group without its own gate. Here it
// cannot escape the suite by being forgotten.

const APP_DIR = join(process.cwd(), "apps", "main", "src", "app");
const adminRoutes = enumeratePageRoutes(APP_DIR, "(admin)");

// Guard the false-empty trap: if enumeration silently returns nothing (app dir
// moved, group renamed), the loop below would generate zero tests and the file
// would "pass" while probing nothing. Make that loud instead.
test("enumerator finds the admin page surface", () => {
  const urls = adminRoutes.map((r) => r.urlPath);
  expect(urls).toContain("/supervisor");
  expect(urls).toContain("/admin");
  expect(adminRoutes.length).toBeGreaterThanOrEqual(10);
});

for (const route of adminRoutes) {
  test(`unauthenticated GET ${route.urlPath} → 404`, async ({ request }) => {
    // No headers at all: a true anonymous request. maxRedirects:0 so a redirect
    // (e.g. to a sign-in page) fails the 404 assertion instead of being followed
    // and masked.
    const res = await request.get(route.probePath, { maxRedirects: 0 });
    expect(res.status()).toBe(404);
  });
}
