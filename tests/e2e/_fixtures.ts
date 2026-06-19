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
    if (!fs.existsSync(STORAGE_STATE_PATH)) {
      throw new Error(
        "authedPage: no storageState found. " +
          "Set TEST_E2E_OWNER_EMAIL, TEST_E2E_OWNER_PASSWORD, " +
          "NEXT_PUBLIC_SUPABASE_URL, and NEXT_PUBLIC_SUPABASE_ANON_KEY " +
          "then re-run to generate " +
          STORAGE_STATE_PATH,
      );
    }
    const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

export { expect } from "@playwright/test";
