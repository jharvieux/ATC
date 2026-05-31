import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { CONTACT_ID, HEADERS, HEADERS_NO_AUTH, TENANT } from "./_helpers";

// §12.4 — /api/quotes POST. Real handler that INSERTs into quotes via
// tenantClient (tenant_id auto-injected). Needs a seeded contact_id.

test.describe.configure({ mode: "serial" });

const SUPABASE_DB_URL =
  process.env.SUPABASE_DB_URL ?? `postgresql://${process.env.USER}@localhost:5432/atc_main_test`;
const sql = postgres(SUPABASE_DB_URL, { max: 2, idle_timeout: 5, onnotice: () => {} });

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

// TODO(#459): quote-detail and customer-accept routes not yet wired.
test.fixme("quote detail page loads with correct information", async () => {});
test.fixme("customer can accept a quote", async () => {});
