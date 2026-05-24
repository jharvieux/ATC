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
  const res = await request.post("/api/quotes", {
    headers: HEADERS,
    data: {
      contact_id: CONTACT_ID,
      cruise_line: "Royal Caribbean",
      ship_name: "Symphony of the Seas",
      passenger_count: 2,
      total_amount: 2499.99,
    },
  });
  expect(res.status()).toBe(201);
  const quote = await res.json();
  expect(quote.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(quote.tenant_id).toBe(TENANT);
  expect(quote.status).toBe("draft");
  expect(quote.cruise_line).toBe("Royal Caribbean");

  // DB assertion — the row really exists and is scoped to our tenant.
  const rows = await sql<Array<{ status: string; tenant_id: string }>>`
    SELECT status, tenant_id FROM public.quotes WHERE id = ${quote.id}::uuid
  `;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.tenant_id).toBe(TENANT);
});

// TODO when the quote-detail / accept routes are wired:
test.skip("quote detail page loads with correct information", async () => {});
test.skip("customer can accept a quote", async () => {});
