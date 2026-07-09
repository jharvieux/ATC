import { test, expect } from "./_fixtures";
import { chromium, type Page } from "@playwright/test";
import {
  provisionEnabled,
  provisionTestTenant,
  teardownTestTenant,
  tenantRecordExists,
  ownerSessionCookie,
  PROVISION_SKIP_REASON,
  type ProvisionedTenant,
} from "./_provision-tenant.js";

// §15 / §7.1 — Tenant onboarding-funnel smoke test against a REAL deployed
// subdomain (beta / staging), not the local Tier-2.5 stack.
//
// Why a separate spec from the per-PR e2e suite: the entire class of bugs this
// guards (#1131/#1132/#1133 Stripe return-URL host resolution, #1134 post-login
// 500, #1048/#1091 silent permission 403) is invisible to localhost unit/e2e
// runs because those mock the host and the DB. Only a real subdomain exercises
// host/tenant resolution, real redirects, and real PostgREST relationships.
//
// GATING (mirrors the describeIf / SUPABASE_DB_URL convention in
// apps/main/test/integration/): this whole describe SKIPS LOUDLY unless BOTH
//   - TEST_E2E_OWNER_EMAIL + TEST_E2E_OWNER_PASSWORD are set (tracked in #1286;
//     these GitHub Actions secrets are NOT provisioned yet), and
//   - BASE_URL points at a real deployment (not localhost/127.0.0.1).
// So it never runs — and never falsely fails — on PR CI (local stack, no owner
// creds). It activates only in the deploy.yml staging E2E step, which sets both.

const OWNER_EMAIL = process.env.TEST_E2E_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.TEST_E2E_OWNER_PASSWORD;
const BASE_URL = process.env.BASE_URL ?? "";
const IS_REAL_DEPLOYMENT = BASE_URL !== "" && !/localhost|127\.0\.0\.1/.test(BASE_URL);

const FUNNEL_ENABLED = Boolean(OWNER_EMAIL && OWNER_PASSWORD && IS_REAL_DEPLOYMENT);

const SKIP_REASON =
  "onboarding-funnel: requires TEST_E2E_OWNER_EMAIL + TEST_E2E_OWNER_PASSWORD " +
  "(GitHub secrets tracked in #1286, not yet provisioned) AND a real BASE_URL " +
  "(non-localhost beta/staging deployment). Skipping cleanly until provisioned.";

test.describe("onboarding funnel smoke (beta/staging)", () => {
  // Loud, standalone skip annotation — surfaces the exact missing prerequisites
  // in the Playwright report instead of a silent no-op.
  test.skip(!FUNNEL_ENABLED, SKIP_REASON);

  // Steps 1-3 (fresh-subdomain sign-up → tenant record + Stripe Connect
  // return_url host) live in their own describe below — they provision a
  // disposable tenant and have different prerequisites from the authedPage
  // steps here. See "onboarding funnel provisioning" (#1724).

  // Step 4 (#1134): first login must land on a real post-login destination
  // without a 500. app/page.tsx calls resolvePostLoginDestination for an
  // authenticated visitor — the #1134 regression surfaced there as a 500 from
  // resolve-post-login. Assert the authed root load is non-5xx and resolves to
  // a real dashboard surface (a redirect to /crm/contacts / /chat / an
  // /onboarding stage), never an error page.
  test("step 4: first login resolves to a dashboard without a 500 (#1134)", async ({
    authedPage,
  }) => {
    const resp = await authedPage.goto("/", { waitUntil: "domcontentloaded" });
    expect(resp, "root navigation should return a response").not.toBeNull();
    // resolve-post-login throwing (the #1134 surface) renders a 500. Any 5xx here
    // is the regression. Redirects are followed by Playwright, so the final
    // response reflects the landed destination.
    expect(resp!.status(), "authed root load must not 5xx (resolve-post-login)").toBeLessThan(500);

    // Landed on a real authenticated surface, not bounced back to the public
    // sign-in — the post-login dispatch produced a destination.
    await expect(authedPage).not.toHaveURL(/\/auth\/reauth/);
    expect(new URL(authedPage.url()).pathname, "must land on a real dashboard surface").toMatch(
      /^\/(crm|chat|onboarding)(\/|$)/,
    );
  });

  // Step 5 (#1048/#1091): a permission-gated tenant action must succeed for the
  // owner — the silent-403 surface. /crm/contacts is the tenant_owner home and
  // is behind assertPermission; a permission-matrix regression returns 403.
  test("step 5: permission-gated tenant action is not silently 403'd (#1048/#1091)", async ({
    authedPage,
  }) => {
    const resp = await authedPage.goto("/crm/contacts", {
      waitUntil: "domcontentloaded",
    });
    expect(resp, "crm navigation should return a response").not.toBeNull();
    expect(
      resp!.status(),
      "tenant owner must not be 403'd on the CRM home (permission-matrix regression)",
    ).not.toBe(403);
    expect(resp!.status(), "crm home must not 5xx").toBeLessThan(500);
    await expect(authedPage).toHaveURL(/\/crm\/contacts/);
  });
});

// ---------------------------------------------------------------------------
// Steps 1-3 (#1724): fresh-subdomain sign-up + Stripe Connect test-mode return.
//
// These provision a DISPOSABLE tenant on a fresh subdomain (service-role seed),
// exercise the funnel as its brand-new owner, and tear the tenant down after.
// A fresh tenant is required because the regressions guarded here only surface
// on a first-time tenant: #1134 (first-login 500) and #1131/#1132/#1133 (Stripe
// return_url resolving to the platform origin instead of the tenant host).
//
// Extra prerequisites beyond the authedPage steps above (see _provision-tenant):
// SUPABASE_SERVICE_ROLE_KEY + TEST_E2E_TENANT_APEX. Absent, this whole group
// SKIPS LOUDLY — provisioning never runs against an unknown target.

// Drives Stripe's hosted Connect onboarding in TEST MODE to the point where it
// redirects back to return_url. Stripe test-mode Express accounts expose a
// "Skip this account form" affordance that completes onboarding immediately;
// its exact label/role has shifted across Stripe UI revisions, so we try a few
// resilient locators and fail LOUD (naming the dependency) if none resolve —
// that failure is the actionable signal that the Stripe UI changed, not a flake
// to swallow. NOTE: this interaction is validated only against a live Stripe
// test env (gated); when the #1286/#1287 secrets land, first-run may need the
// locator list refreshed (tracked in #1724).
async function completeStripeTestOnboarding(page: Page, returnHost: string): Promise<void> {
  const returnRe = new RegExp(`^https://${returnHost.replace(/\./g, "\\.")}/`);
  const skipLocators = [
    page.getByRole("button", { name: /skip this (account )?form/i }),
    page.getByRole("link", { name: /skip this (account )?form/i }),
    page.getByText(/skip this account form/i),
  ];

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (returnRe.test(page.url())) return; // Already bounced back to the tenant.
    for (const loc of skipLocators) {
      if (await loc.count().catch(() => 0)) {
        await loc.first().click({ timeout: 5_000 }).catch(() => undefined);
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        break;
      }
    }
    await page.waitForTimeout(1_000);
  }

  if (!returnRe.test(page.url())) {
    throw new Error(
      `completeStripeTestOnboarding: never redirected to ${returnHost} — last URL ${page.url()}. ` +
        "Stripe test-mode 'Skip this account form' affordance not found or the return did not fire; " +
        "refresh the locator list in this helper (#1724).",
    );
  }
}

test.describe("onboarding funnel provisioning (beta/staging)", () => {
  test.skip(!provisionEnabled(), PROVISION_SKIP_REASON);
  // Serialize: the three steps share one provisioned tenant and one browser
  // context, and step order (record → subdomain → Stripe) mirrors the funnel.
  test.describe.configure({ mode: "serial" });

  let tenant: ProvisionedTenant | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  let page: Page | null = null;

  test.beforeAll(async () => {
    if (!provisionEnabled()) return;
    tenant = await provisionTestTenant();
    browser = await chromium.launch();
    const context = await browser.newContext();
    await context.addCookies([await ownerSessionCookie(tenant)]);
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await browser?.close().catch(() => undefined);
    if (tenant) await teardownTestTenant(tenant);
  });

  test("step 1: fresh-subdomain sign-up creates a tenant record (#1159, #1724)", async () => {
    expect(tenant, "provisioning must have produced a tenant").not.toBeNull();
    // The seed stands in for the OAuth-only sign-up path (no password form to
    // drive): the assertion that matters is a real, active tenant row exists.
    expect(await tenantRecordExists(tenant!.tenantId)).toBe(true);
  });

  test("step 2: fresh subdomain resolves and first login does not 500 (#1134, #1724)", async () => {
    expect(page, "browser page must be initialized").not.toBeNull();
    const resp = await page!.goto(`${tenant!.origin}/`, { waitUntil: "domcontentloaded" });
    expect(resp, "root navigation should return a response").not.toBeNull();
    // A slug that didn't resolve would fall through to the platform sentinel and
    // resolve-post-login would 500 (#1134). The fresh tenant host must stay on
    // its own host and never render an error page.
    expect(resp!.status(), "fresh-tenant first load must not 5xx (#1134)").toBeLessThan(500);
    expect(new URL(page!.url()).host, "must stay on the tenant subdomain, not bounce to platform").toBe(
      tenant!.host,
    );
  });

  test("step 3: Stripe Connect return_url resolves to the tenant host (#1131/#1132/#1133, #1724)", async () => {
    // completeStripeTestOnboarding polls up to 60s; Playwright's default
    // per-test timeout is 30s, so the helper's budget alone can exceed it.
    test.setTimeout(90_000);
    expect(page, "browser page must be initialized").not.toBeNull();
    const linkResp = await page!.request.post(`${tenant!.origin}/api/onboarding/connect/link`);

    // Stripe not wired on the target env (no test secret / onboarding paused) —
    // skip loudly rather than fail; the return-host regression can't be probed.
    if (linkResp.status() === 500 || linkResp.status() === 403) {
      test.skip(
        true,
        `connect/link returned ${linkResp.status()} (${await linkResp.text()}) — Stripe test mode ` +
          "not configured / onboarding disabled on this target. Set a Stripe TEST secret key + " +
          "STRIPE_CONNECT_ONBOARDING_ENABLED to exercise the return_url regression (#1724).",
      );
      return;
    }
    expect(linkResp.status(), "connect/link should succeed for the tenant owner").toBe(200);

    const { url } = (await linkResp.json()) as { url?: string };
    expect(url, "connect/link must return a Stripe-hosted account-link URL").toBeTruthy();
    expect(new URL(url!).host, "account link must be a Stripe-hosted URL").toMatch(/(^|\.)stripe\.com$/);

    // The regression: return_url must point at the tenant host, not the platform
    // origin. Drive the hosted test-mode flow and assert the browser lands back
    // on the tenant subdomain's /onboarding/branding (the route's return_url).
    await page!.goto(url!, { waitUntil: "domcontentloaded" });
    await completeStripeTestOnboarding(page!, tenant!.host);

    const landed = new URL(page!.url());
    expect(landed.host, "Stripe return_url must resolve to the tenant host (#1132)").toBe(tenant!.host);
    expect(landed.pathname, "return_url path must be the onboarding branding stage").toBe(
      "/onboarding/branding",
    );
  });
});
