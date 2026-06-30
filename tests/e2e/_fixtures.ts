// §e2e — Playwright fixture: authedPage
//
// Extends Playwright's base test with an `authedPage` fixture that opens a
// browser page pre-loaded with a real GoTrue session. The session is written
// by global-setup.ts; this fixture simply loads the resulting storageState.
//
// Usage:
//   import { test, expect } from "./_fixtures";
//   test("some authenticated flow", async ({ authedPage }) => { ... });

import { test as base, type Page } from "@playwright/test";
import * as fs from "node:fs";
import { STORAGE_STATE_PATH } from "./global-setup.js";

export const test = base.extend<{ authedPage: Page }>({
  authedPage: async ({ browser }, use) => {
    if (fs.existsSync(STORAGE_STATE_PATH)) {
      // Real GoTrue session written by global-setup (staging / cloud Supabase).
      const context = await browser.newContext({
        storageState: STORAGE_STATE_PATH,
      });
      const page = await context.newPage();
      await use(page);
      await context.close();
      return;
    }

    const bypassToken = process.env.TEST_AUTH_BYPASS_TOKEN;
    if (bypassToken) {
      // Local CI: no GoTrue running. Inject the bypass Bearer on every request
      // so the Next.js middleware and getCachedUser() authenticate via the
      // seeded E2E user (a0000000-... / tenant 22222222-...) without a real
      // Supabase session. Requires TEST_AUTH_BYPASS_USER_ID + _TENANT_ID set.
      const context = await browser.newContext({
        extraHTTPHeaders: { Authorization: `Bearer ${bypassToken}` },
      });
      const page = await context.newPage();
      await use(page);
      await context.close();
      return;
    }

    throw new Error(
      "authedPage: no storageState found and TEST_AUTH_BYPASS_TOKEN is not set. " +
        "For cloud/staging: set TEST_E2E_OWNER_EMAIL, TEST_E2E_OWNER_PASSWORD, " +
        "NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
        "For local CI: set TEST_AUTH_BYPASS_TOKEN (already in e2e.yml env).",
    );
  },
});

export { expect } from "@playwright/test";
