// Regression test for the CSP form-action allowlist.
//
// Background: OAuth signup posts to /api/auth/oauth-initiate which 302s the
// browser to https://<project>.supabase.co/auth/v1/authorize. Browsers apply
// form-action to the FULL redirect chain (CSP3 spec / Chrome). With only
// 'self' in form-action, the redirect was silently blocked and every signup
// click did nothing — only observable via /api/security/csp-report.
//
// This test pins the contract: form-action MUST include the Supabase host
// derived from NEXT_PUBLIC_SUPABASE_URL whenever that env is set.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function loadConfig(): Promise<{ headers: () => Promise<unknown[]> }> {
  // Force a fresh require so env var changes take effect.
  delete require.cache[require.resolve("../../../next.config.js")];
  return require("../../../next.config.js") as { headers: () => Promise<unknown[]> };
}

async function getCspHeader(): Promise<string> {
  const cfg = await loadConfig();
  const all = await cfg.headers();
  const securityRoute = (all as Array<{ source: string; headers: Array<{ key: string; value: string }> }>)[0];
  const csp = securityRoute?.headers.find((h) => h.key === "Content-Security-Policy" || h.key === "Content-Security-Policy-Report-Only");
  if (!csp) throw new Error("CSP header not in next.config headers()");
  return csp.value;
}

describe("CSP form-action allowlist", () => {
  beforeEach(() => {
    // `process.env.NODE_ENV` is typed read-only; the test runs under
    // NODE_ENV=test which already takes the same enforcing branch in
    // next.config.js (anything !== "production" goes report-only, but
    // both branches produce the same CSP string — we just need the value
    // back regardless of header name).
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc123.supabase.co";
  });

  it("includes 'self' so same-origin form posts work (sign-in, settings)", async () => {
    const csp = await getCspHeader();
    expect(csp).toMatch(/form-action [^;]*'self'/);
  });

  it("includes the Supabase host so the OAuth redirect chain isn't blocked", async () => {
    const csp = await getCspHeader();
    expect(csp).toMatch(/form-action [^;]*https:\/\/abc123\.supabase\.co/);
  });

  it("omits the Supabase source when NEXT_PUBLIC_SUPABASE_URL is missing (fail-closed)", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const csp = await getCspHeader();
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toMatch(/form-action [^;]*supabase\.co/);
  });

  it("omits the Supabase source on a malformed URL (fail-closed, not '*')", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "not-a-url";
    const csp = await getCspHeader();
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain("*");
  });

  // OAuth provider redirect chain — Chrome CSP3 applies form-action to every
  // hop. Supabase redirects the browser to the IdP after authorize; without
  // these the click silently aborts at the final redirect to the provider.
  it("includes login.microsoftonline.com for the Microsoft OAuth redirect chain", async () => {
    const csp = await getCspHeader();
    expect(csp).toMatch(/form-action [^;]*https:\/\/login\.microsoftonline\.com/);
  });

  it("includes accounts.google.com for the Google OAuth redirect chain", async () => {
    const csp = await getCspHeader();
    expect(csp).toMatch(/form-action [^;]*https:\/\/accounts\.google\.com/);
  });

  it("includes www.facebook.com for the Facebook OAuth redirect chain", async () => {
    const csp = await getCspHeader();
    expect(csp).toMatch(/form-action [^;]*https:\/\/www\.facebook\.com/);
  });
});
