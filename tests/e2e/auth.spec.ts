import { test, expect } from "@playwright/test";
import { HEADERS, HEADERS_NO_AUTH } from "./_helpers";

// §7.1 — /api/auth/me. Stub (501) but auth-gated. Tests verify the
// auth-gate behaviour; if the stub graduates to a real handler the
// 501 assertion should be tightened.

test("GET /api/auth/me without auth → 401", async ({ request }) => {
  const res = await request.get("/api/auth/me", { headers: HEADERS_NO_AUTH });
  expect(res.status()).toBe(401);
});

test("GET /api/auth/me with bypass → past the auth gate", async ({ request }) => {
  const res = await request.get("/api/auth/me", { headers: HEADERS });
  expect([200, 501]).toContain(res.status());
});

test("GET /api/auth/me with bogus Bearer → 401", async ({ request }) => {
  const res = await request.get("/api/auth/me", {
    headers: { ...HEADERS, Authorization: "Bearer not-the-bypass-token" },
  });
  expect(res.status()).toBe(401);
});

// TODO(#459): GoTrue / OAuth E2E flows not yet wired for local test runner.
test.fixme("sign in with valid credentials", async () => {});
test.fixme("sign out clears session", async () => {});

// proxy.ts §1d — isLoginGatedPath("/onboarding") → redirect to /auth/reauth
// when no session cookie or bypass Bearer is present.
test("unauthenticated access redirects to sign-in", async ({ page }) => {
  await page.goto("/onboarding", { waitUntil: "commit" });
  await expect(page).toHaveURL(/\/auth\/reauth/);
});
