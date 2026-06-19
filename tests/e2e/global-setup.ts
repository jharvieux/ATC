// §e2e — Playwright global setup: establish a real GoTrue browser session.
//
// Signs in once per test run using TEST_E2E_OWNER_EMAIL / TEST_E2E_OWNER_PASSWORD,
// injects the resulting session as an sb-<ref>-auth-token cookie into a headless
// browser context, and saves storageState to .auth/owner.json.
//
// The authedPage fixture (see _fixtures.ts) loads that storageState in per-test
// browser contexts so server components' getCachedUser() → supabase.auth.getUser()
// sees a real session instead of unauthenticated null.
//
// Why cookie injection vs. UI sign-in: the app uses OAuth-only sign-in flows
// (PKCE via Microsoft/Google/Facebook), so there is no password form to fill.
// Direct cookie injection is the standard Playwright pattern for SSR auth.
//
// @supabase/ssr stores session JSON in sb-<projectRef>-auth-token with no
// base64 prefix (cookieEncoding defaults to plain). decodeChunkedCookieValue
// returns values without the "base64-" prefix verbatim, so raw JSON is correct.

import { chromium, type FullConfig } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

// CWD is always the repo root when Playwright invokes global-setup (same
// directory as playwright.config.ts). Avoid import.meta.url — Playwright's
// TypeScript transform targets CJS on this project, where import.meta is
// not defined.
export const STORAGE_STATE_PATH = path.join(
  process.cwd(),
  "tests",
  "e2e",
  ".auth",
  "owner.json",
);

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const email = process.env["TEST_E2E_OWNER_EMAIL"];
  const ownerPassword = process.env["TEST_E2E_OWNER_PASSWORD"];
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const anonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];
  const baseUrl = process.env["BASE_URL"] ?? "http://localhost:3000";

  if (!email || !ownerPassword || !supabaseUrl || !anonKey) {
    // Credentials absent — authedPage fixture will throw when a test uses it.
    // Safe for unauthenticated test suites that don't depend on authedPage.
    return;
  }

  const resp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: anonKey,
    },
    body: JSON.stringify({ email, password: ownerPassword }),
  });

  if (!resp.ok) {
    throw new Error(
      `global-setup: GoTrue sign-in failed (${resp.status}): ${await resp.text()}`,
    );
  }

  const session: unknown = await resp.json();

  // sb-<projectRef>-auth-token is the key @supabase/auth-js uses for session
  // storage. projectRef is the first DNS label of the Supabase hostname.
  const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
  const cookieName = `sb-${projectRef}-auth-token`;

  const parsed = new URL(baseUrl);
  const cookieDomain = parsed.hostname;
  const secure = parsed.protocol === "https:";

  fs.mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext();

  // Inject the session directly — bypasses the OAuth flow while still producing
  // a cookie that @supabase/ssr can read server-side. Playwright's addCookies
  // can set HttpOnly cookies in test contexts (server-set-only in prod).
  await context.addCookies([
    {
      name: cookieName,
      value: JSON.stringify(session),
      domain: cookieDomain,
      path: "/",
      httpOnly: true,
      secure,
      sameSite: "Lax",
    },
  ]);

  await context.storageState({ path: STORAGE_STATE_PATH });
  await browser.close();
}
