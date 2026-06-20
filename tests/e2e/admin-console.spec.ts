import { test, expect } from "./_fixtures";

// Tenant admin console — settings index, branding, billing (§7.2).
//
// All three tests use the authedPage fixture (GoTrue session established by
// global-setup.ts). They will throw if TEST_E2E_OWNER_EMAIL /
// TEST_E2E_OWNER_PASSWORD / NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY
// are not set in the environment — set those secrets to enable this tier.

test("tenant admin can access admin console", async ({ authedPage }) => {
  // §7.2 — /settings renders "Admin Console" for an authenticated tenant owner.
  await authedPage.goto("/settings");
  await expect(authedPage).toHaveURL(/\/settings/);
  await expect(authedPage.locator("h1")).toContainText("Admin Console");
});

test("admin can update branding settings", async ({ authedPage }) => {
  // §16 — /settings/branding renders the branding form for authenticated admins.
  await authedPage.goto("/settings/branding");
  await expect(authedPage).toHaveURL(/\/settings\/branding/);
  await expect(authedPage.locator("h1")).toContainText("Branding");
});

test("admin can view billing status", async ({ authedPage }) => {
  // §15.15 — /settings/billing renders subscription info for tenant billing admins.
  await authedPage.goto("/settings/billing");
  await expect(authedPage).toHaveURL(/\/settings\/billing/);
  await expect(authedPage.locator("h1")).toContainText("Billing");
});
