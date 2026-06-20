import { test, expect } from "./_fixtures";
import postgres from "postgres";
import { CONTACT_ID, HEADERS, HEADERS_NO_AUTH, TENANT } from "./_helpers";

// §12.4 — /api/quotes POST. Real handler that INSERTs into quotes via
// tenantClient (tenant_id auto-injected). Needs a seeded contact_id.

test.describe.configure({ mode: "serial" });

const SUPABASE_DB_URL =
  process.env.SUPABASE_DB_URL ?? `postgresql://${process.env.USER}@localhost:5432/atc_main_test`;
const sql = postgres(SUPABASE_DB_URL, { max: 2, idle_timeout: 5, onnotice: () => {} });

// Token stamped directly via SQL (avoids the PDF/storage send pipeline).
const CUSTOMER_TOKEN = "e2e-test-customer-token-quotes";

test.afterAll(async () => { await sql.end(); });

test.beforeEach(async () => {
  // Clean up any quotes left over from prior runs so list assertions are stable.
  // quote_options FK-cascades on quote delete.
  await sql`DELETE FROM public.quotes WHERE tenant_id = ${TENANT}::uuid`;
});

test("POST /api/quotes without auth → 401", async ({ request }) => {
  const res = await request.post("/api/quotes", {
    headers: HEADERS_NO_AUTH,
    data: { contact_id: CONTACT_ID },
  });
  expect(res.status()).toBe(401);
});

test("POST /api/quotes rejects malformed body with 400", async ({ request }) => {
  const res = await request.post("/api/quotes", {
    headers: HEADERS,
    data: { contact_id: "not-a-uuid" },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toBe("Invalid body");
});

test("POST /api/quotes creates a draft quote with tenant_id auto-injected", async ({ request }) => {
  // §38 — Container-level fields land on the quote row; option-level
  // fields (cruise_line, ship_name, ...) land on quote_options[index=1].
  const res = await request.post("/api/quotes", {
    headers: HEADERS,
    data: {
      contact_id: CONTACT_ID,
      cruise_line: "Royal Caribbean",
      ship_name: "Symphony of the Seas",
      passenger_count: 2,
      total_amount_cents: 249999,
    },
  });
  expect(res.status()).toBe(201);
  const quote = await res.json();
  expect(quote.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(quote.tenant_id).toBe(TENANT);
  expect(quote.status).toBe("draft");

  // DB assertion — the quote row exists and is scoped to our tenant.
  const rows = await sql<Array<{ status: string; tenant_id: string }>>`
    SELECT status, tenant_id FROM public.quotes WHERE id = ${quote.id}::uuid
  `;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.tenant_id).toBe(TENANT);

  // Option fields landed on quote_options[index=1].
  const options = await sql<Array<{ cruise_line: string; ship_name: string }>>`
    SELECT cruise_line, ship_name FROM public.quote_options
    WHERE quote_id = ${quote.id}::uuid AND option_index = 1
  `;
  expect(options).toHaveLength(1);
  expect(options[0]!.cruise_line).toBe("Royal Caribbean");
  expect(options[0]!.ship_name).toBe("Symphony of the Seas");
});

test("quote detail page loads with correct information", async ({ authedPage, request }) => {
  // /crm/quotes/[id] renders quote info for authenticated agents.
  // The beforeEach has cleared all quotes; create a fresh one for this test.
  // Requires TEST_E2E_OWNER_EMAIL / TEST_E2E_OWNER_PASSWORD to be set.
  const res = await request.post("/api/quotes", {
    headers: HEADERS,
    data: {
      contact_id: CONTACT_ID,
      cruise_line: "Royal Caribbean",
      ship_name: "Symphony of the Seas",
      passenger_count: 2,
      total_amount_cents: 249999,
    },
  });
  expect(res.status()).toBe(201);
  const { id } = await res.json() as { id: string };

  await authedPage.goto(`/crm/quotes/${id}`);
  await expect(authedPage).toHaveURL(new RegExp(`/crm/quotes/${id}`));
  // h1 is "{cruise_line} — {ship_name}" from the quote_options row.
  await expect(authedPage.locator("h1")).toContainText("Royal Caribbean");
});

test("customer can view a sent quote via public /q/[token] URL", async ({ page, request }) => {
  // /q/[token] is a public server-rendered page. Create the quote via API
  // so quote_options (cruise_line) are seeded, then stamp
  // customer_access_token directly to avoid driving the
  // /api/quotes/[id]/send PDF-render + Supabase Storage upload pipeline.
  //
  // Regression surface: #1131/#1132/#1133 (wrong-host token resolution) would
  // cause a 404/redirect here even for a valid token.
  const res = await request.post("/api/quotes", {
    headers: HEADERS,
    data: {
      contact_id: CONTACT_ID,
      cruise_line: "Royal Caribbean",
      ship_name: "Symphony of the Seas",
      passenger_count: 2,
      total_amount_cents: 249999,
    },
  });
  expect(res.status()).toBe(201);
  const { id } = await res.json() as { id: string };

  const updated = await sql`
    UPDATE public.quotes
    SET status = 'sent', customer_access_token = ${CUSTOMER_TOKEN},
        sent_at = now(), updated_at = now()
    WHERE id = ${id}::uuid AND tenant_id = ${TENANT}::uuid
  `;
  expect(updated.count).toBe(1);

  await page.goto(`/q/${CUSTOMER_TOKEN}`);
  await expect(page).toHaveURL(new RegExp(`/q/${CUSTOMER_TOKEN}`));
  // h1 is "{cruise_line} — {ship_name}" when option row has both fields.
  await expect(page.locator("h1")).toContainText("Royal Caribbean");
});
