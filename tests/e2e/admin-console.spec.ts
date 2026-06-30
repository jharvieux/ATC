import { test, expect } from "./_fixtures";

// Tenant admin console — settings index, branding, billing.
//
// All three tests use the authedPage fixture, which authenticates via one of
// two paths (see _fixtures.ts):
//   - Local CI (e2e.yml): TEST_AUTH_BYPASS_TOKEN is set; no GoTrue needed.
//   - Staging / cloud: GoTrue session written by global-setup.ts using
//     TEST_E2E_OWNER_EMAIL + TEST_E2E_OWNER_PASSWORD + NEXT_PUBLIC_SUPABASE_URL
//     + NEXT_PUBLIC_SUPABASE_ANON_KEY.

test("tenant admin can access admin console", async ({ authedPage }) => {
  // /settings renders a personalised welcome message for an authenticated tenant owner.
  await authedPage.goto("/settings");
  await expect(authedPage).toHaveURL(/\/settings/);
  await expect(authedPage.locator("h1")).toContainText("Welcome back");
});

test("admin can update branding settings", async ({ authedPage }) => {
  // /settings/branding renders the branding form for authenticated admins.
  await authedPage.goto("/settings/branding");
  await expect(authedPage).toHaveURL(/\/settings\/branding/);
  await expect(authedPage.locator("h1")).toContainText("Branding");
});

test("admin can view billing status", async ({ authedPage }) => {
  // /settings/billing renders subscription info for tenant billing admins.
  await authedPage.goto("/settings/billing");
  await expect(authedPage).toHaveURL(/\/settings\/billing/);
  await expect(authedPage.locator("h1")).toContainText("Billing");
});
