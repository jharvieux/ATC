import { test, expect } from "./_fixtures";

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

  // Steps 1-2 (fresh-subdomain sign-up → tenant record creation) and step 3
  // (Stripe Connect test-mode return → return_url host assertion) need a
  // provisioning + Stripe harness that does not exist yet — the app is
  // OAuth-only (no password sign-up form to drive) and the connect/link route
  // returns Stripe's hosted URL, not the return_url, so the host can't be
  // asserted from the client. Deferred to #1724 with the concrete regressions
  // each must guard captured there.
  test.fixme(
    "step 1-2: fresh-subdomain sign-up creates a tenant record (#1724)",
    async () => {},
  );
  test.fixme(
    "step 3: Stripe Connect return_url resolves to the tenant host (#1131/#1132/#1133, #1724)",
    async () => {},
  );

  // Step 4 (#1134): first login must land on a real post-login destination
  // without a 500. app/page.tsx calls resolvePostLoginDestination for an
  // authenticated visitor — the #1134 regression surfaced there as a 500 from
  // resolve-post-login. Assert the authed root load is non-5xx and resolves to
  // a real surface (tenant shell at "/", or a redirect to /crm/contacts /
  // /chat / an /onboarding stage), never an error page.
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
    await expect(authedPage).toHaveURL(/\/(crm|chat|onboarding)?/);
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
