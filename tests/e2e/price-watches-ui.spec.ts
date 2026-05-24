import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { BYPASS, CONTACT_ID, HEADERS, TENANT } from "./_helpers";

// BP40 §33.8 — subscriber-facing price-watch dashboard UI.
//
// The browser navigates to /settings/price-watches; Playwright's
// page.route() injects the Tier-2 bypass Bearer + tenant header on
// every /api/* request so the page can talk to the API without
// Supabase Auth.

test.describe.configure({ mode: "serial" });

const SUPABASE_DB_URL =
  process.env.SUPABASE_DB_URL ?? `postgresql://${process.env.USER}@localhost:5432/atc_main_test`;
const sql = postgres(SUPABASE_DB_URL, { max: 2, idle_timeout: 5, onnotice: () => {} });

test.afterAll(async () => { await sql.end(); });

const SHIP = "symphony-of-the-seas-uiE2E";

async function clearWatches(): Promise<void> {
  // Scope deletes to THIS spec's ship so we don't trample the
  // sibling price-watch.spec.ts running in parallel.
  await sql`DELETE FROM public.price_watches WHERE tenant_id = ${TENANT}::uuid AND ship = ${SHIP}`;
  await sql`DELETE FROM public.pricing_cache WHERE ship = ${SHIP}`;
}

async function seedCacheAndWatch(): Promise<void> {
  await sql`
    INSERT INTO public.pricing_cache (
      cruise_line, ship, sail_date, departure_port, duration_nights,
      cabin_class, price_amount, price_currency, fetched_at, source
    ) VALUES ('RCL', ${SHIP}, '2026-08-15', 'MIA', 7, 'interior', 1000, 'USD', NOW(), 'apify')
    ON CONFLICT (cruise_line, ship, sail_date, departure_port, duration_nights, cabin_class)
    DO UPDATE SET price_amount = 1000
  `;
}

test.beforeEach(async ({ page }) => {
  await clearWatches();
  // Inject the bypass headers on every API call the browser makes.
  // We can't set cookies from the browser side (no GoTrue), so the
  // server-side bypass relies on the Bearer + tenant header.
  await page.route("**/api/**", async (route) => {
    const headers = { ...route.request().headers(), ...HEADERS };
    await route.continue({ headers });
  });
});

test("dashboard loads and the heading renders", async ({ page }) => {
  await page.goto("/settings/price-watches");
  await expect(page.getByRole("heading", { name: /price watches/i })).toBeVisible();
  // Don't assert on empty-state vs rows — the other Playwright spec files
  // share the same fixture tenant and may have watches mid-test. The
  // following per-row tests seed their own data and assert against it.
});

test("dashboard lists a seeded active watch with the right ship + badge", async ({ page, request }) => {
  await seedCacheAndWatch();
  // Create via API (already proven to work) so the page has data to render.
  const create = await request.post("/api/price-watches", {
    headers: { ...HEADERS, Authorization: `Bearer ${BYPASS}` },
    data: {
      cruise_line: "RCL", ship: SHIP, sail_date: "2026-08-15",
      departure_port: "MIA", cabin_class: "interior",
      threshold_kind: "dollar_drop", dollar_threshold: 100,
      booking_id: null,
    },
  });
  expect(create.status()).toBe(200);

  await page.goto("/settings/price-watches");
  const row = page.getByTestId("price-watch-row").filter({ hasText: SHIP });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("status-badge")).toHaveText(/active/i);
});

test("pause + resume round-trip via UI buttons updates the badge", async ({ page, request }) => {
  await seedCacheAndWatch();
  await request.post("/api/price-watches", {
    headers: { ...HEADERS, Authorization: `Bearer ${BYPASS}` },
    data: {
      cruise_line: "RCL", ship: SHIP, sail_date: "2026-08-15",
      departure_port: "MIA", cabin_class: "interior",
      threshold_kind: "dollar_drop", dollar_threshold: 100,
    },
  });

  await page.goto("/settings/price-watches");
  const row = page.getByTestId("price-watch-row").filter({ hasText: SHIP });
  await row.getByRole("button", { name: "Pause" }).click();
  await expect(row.getByTestId("status-badge")).toHaveText(/paused/i);
  await row.getByRole("button", { name: "Resume" }).click();
  await expect(row.getByTestId("status-badge")).toHaveText(/active/i);
});

// Use CONTACT_ID to silence unused-import warning when the create flow
// expands later to require a contact link.
void CONTACT_ID;
