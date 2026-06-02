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
// moved, group renamed) or a partial set (a walk bug), the loop below would
// generate too few tests and the file would "pass" while probing little. Make
// that loud. The floor sits just under the live count (19) so a partial-walk
// regression trips it; lower it deliberately if an admin page is ever removed.
test("enumerator finds the admin page surface", () => {
  const urls = adminRoutes.map((r) => r.urlPath);
  expect(urls).toContain("/supervisor");
  expect(urls).toContain("/admin");
  expect(adminRoutes.length).toBeGreaterThanOrEqual(17);
});

for (const route of adminRoutes) {
  test(`unauthenticated GET ${route.urlPath} → 404`, async ({ request }) => {
    // No headers at all: a true anonymous request. maxRedirects:0 returns the
    // raw 3xx instead of following it, so a redirect (e.g. to sign-in) fails the
    // 404 check rather than being masked by the redirect target's status. The
    // required signal is specifically 404 (notFound), not merely "not 200": this
    // probe stays meaningful only while the gate in (admin)/layout.tsx denies
    // with notFound() — if it ever switched to redirect(), this would fail.
    const res = await request.get(route.probePath, { maxRedirects: 0 });
    expect(res.status()).toBe(404);
  });
}
