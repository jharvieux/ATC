import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Tests share a single fixture row in pricing_cache + the same tenant's
// watches table; serialise so beforeEach/afterEach don't race across
// workers. Cheap — these are fast HTTP roundtrips.
test.describe.configure({ mode: "serial" });

// BP40 §33.8 — price-watch API end-to-end.
//
// Runs against local Postgres (atc_main_test) via PostgREST + the
// Tier-2 auth bypass. Each test seeds the cache row it needs, then hits
// the route, then asserts on the response + (where relevant) the DB row
// that was created.

const BYPASS = process.env.TEST_AUTH_BYPASS_TOKEN ?? "tier2-local-test-secret";
const TENANT = process.env.TEST_AUTH_BYPASS_TENANT_ID ?? "22222222-0000-0000-0000-0000000000a1";

const VALID_REQUEST_HEADERS = {
  Authorization: `Bearer ${BYPASS}`,
  "x-resolved-tenant-id": TENANT,
  "Content-Type": "application/json",
};

const VALID_BODY = {
  cruise_line: "RCL",
  ship: "symphony-of-the-seas-e2e",
  sail_date: "2026-08-15",
  departure_port: "MIA",
  cabin_class: "interior" as const,
  threshold_kind: "dollar_drop" as const,
  dollar_threshold: 100,
};

// Direct DB access for fixture seeding + asserts. Bypasses the API
// surface entirely; runs as the postgres superuser (BYPASSRLS).
const SUPABASE_DB_URL =
  process.env.SUPABASE_DB_URL ?? `postgresql://${process.env.USER}@localhost:5432/atc_main_test`;
const sql = postgres(SUPABASE_DB_URL, { max: 2, idle_timeout: 5, onnotice: () => {} });

test.afterAll(async () => {
  await sql.end();
});

async function seedCacheRow(price = 1000): Promise<void> {
  await sql`
    INSERT INTO public.pricing_cache (
      cruise_line, ship, sail_date, departure_port, duration_nights,
      cabin_class, price_amount, price_currency, fetched_at, source
    ) VALUES (
      ${VALID_BODY.cruise_line}, ${VALID_BODY.ship}, ${VALID_BODY.sail_date},
      ${VALID_BODY.departure_port}, 7, ${VALID_BODY.cabin_class},
      ${price}, 'USD', NOW(), 'apify'
    )
    ON CONFLICT (cruise_line, ship, sail_date, departure_port, duration_nights, cabin_class)
    DO UPDATE SET price_amount = EXCLUDED.price_amount, fetched_at = NOW()
  `;
}

async function clearCacheRow(): Promise<void> {
  await sql`
    DELETE FROM public.pricing_cache
    WHERE ship = ${VALID_BODY.ship}
  `;
}

async function clearWatches(): Promise<void> {
  await sql`
    DELETE FROM public.price_watches WHERE tenant_id = ${TENANT}::uuid
  `;
}

test.beforeEach(async () => {
  await clearWatches();
  await clearCacheRow();
});

test("POST /api/price-watches requires auth", async ({ request }) => {
  const res = await request.post("/api/price-watches", {
    headers: { "x-resolved-tenant-id": TENANT, "Content-Type": "application/json" },
    data: VALID_BODY,
  });
  expect(res.status()).toBeGreaterThanOrEqual(400);
  expect(res.status()).toBeLessThan(500);
});

test("POST /api/price-watches rejects malformed body with 400", async ({ request }) => {
  const res = await request.post("/api/price-watches", {
    headers: VALID_REQUEST_HEADERS,
    data: { cruise_line: "RCL" },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toBe("invalid_request");
});

test("POST /api/price-watches returns 422 uncovered_line for unsupported cruise line", async ({ request }) => {
  const res = await request.post("/api/price-watches", {
    headers: VALID_REQUEST_HEADERS,
    data: { ...VALID_BODY, cruise_line: "BCK" },
  });
  expect(res.status()).toBe(422);
  expect((await res.json()).error).toBe("uncovered_line");
});

test("POST /api/price-watches returns 422 price_data_unavailable when cache empty", async ({ request }) => {
  // beforeEach cleared the cache row.
  const res = await request.post("/api/price-watches", {
    headers: VALID_REQUEST_HEADERS,
    data: VALID_BODY,
  });
  expect(res.status()).toBe(422);
  expect((await res.json()).error).toBe("price_data_unavailable");
});

test("POST /api/price-watches creates a watch and returns watch_id", async ({ request }) => {
  await seedCacheRow(1000);
  const res = await request.post("/api/price-watches", {
    headers: VALID_REQUEST_HEADERS,
    data: VALID_BODY,
  });
  expect(res.status()).toBe(200);
  const json = await res.json();
  expect(json.watch_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(json.status).toBe("active");
  expect(json.baseline_price).toBe(1000);
  expect(json.baseline_currency).toBe("USD");

  // DB assertion — the watch row really exists.
  const rows = await sql<Array<{ status: string; baseline_price: string }>>`
    SELECT status, baseline_price FROM public.price_watches WHERE watch_id = ${json.watch_id}::uuid
  `;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("active");
  expect(Number(rows[0]!.baseline_price)).toBe(1000);
});

test("GET /api/price-watches lists caller's watches", async ({ request }) => {
  await seedCacheRow(1000);
  // Seed two watches by hitting the route twice with different ships.
  const r1 = await request.post("/api/price-watches", {
    headers: VALID_REQUEST_HEADERS,
    data: VALID_BODY,
  });
  expect(r1.status()).toBe(200);

  // Second one — different ship so the cache lookup needs another row.
  await sql`
    INSERT INTO public.pricing_cache (
      cruise_line, ship, sail_date, departure_port, duration_nights,
      cabin_class, price_amount, price_currency, fetched_at, source
    ) VALUES ('NCL', 'norwegian-encore-e2e', '2026-09-01', 'MIA', 7, 'interior', 800, 'USD', NOW(), 'apify')
  `;
  const r2 = await request.post("/api/price-watches", {
    headers: VALID_REQUEST_HEADERS,
    data: {
      cruise_line: "NCL", ship: "norwegian-encore-e2e", sail_date: "2026-09-01",
      departure_port: "MIA", cabin_class: "interior",
      threshold_kind: "percent_drop", percent_threshold: 10,
    },
  });
  expect(r2.status()).toBe(200);

  const list = await request.get("/api/price-watches", { headers: VALID_REQUEST_HEADERS });
  expect(list.status()).toBe(200);
  const { watches } = await list.json();
  expect(Array.isArray(watches)).toBe(true);
  expect(watches.length).toBeGreaterThanOrEqual(2);

  // Cleanup the second cache row we added.
  await sql`DELETE FROM public.pricing_cache WHERE ship = 'norwegian-encore-e2e'`;
});

test("PATCH /api/price-watches/[id] pauses a watch", async ({ request }) => {
  await seedCacheRow(1000);
  const created = await request.post("/api/price-watches", {
    headers: VALID_REQUEST_HEADERS,
    data: VALID_BODY,
  });
  const { watch_id } = await created.json();

  const patched = await request.patch(`/api/price-watches/${watch_id}`, {
    headers: VALID_REQUEST_HEADERS,
    data: { status: "paused" },
  });
  expect(patched.status()).toBe(200);

  const rows = await sql<Array<{ status: string }>>`
    SELECT status FROM public.price_watches WHERE watch_id = ${watch_id}::uuid
  `;
  expect(rows[0]!.status).toBe("paused");
});

test("POST /api/price-watches/[id]/rearm resets baseline to current cached price", async ({ request }) => {
  await seedCacheRow(1000);
  const created = await request.post("/api/price-watches", {
    headers: VALID_REQUEST_HEADERS,
    data: VALID_BODY,
  });
  const { watch_id } = await created.json();

  // Price has dropped; rearm should pick up the new value as the new baseline.
  await seedCacheRow(850);
  const rearmed = await request.post(`/api/price-watches/${watch_id}/rearm`, {
    headers: VALID_REQUEST_HEADERS,
  });
  expect(rearmed.status()).toBe(200);
  const json = await rearmed.json();
  expect(json.baseline_price).toBe(850);

  const rows = await sql<Array<{ status: string; baseline_price: string }>>`
    SELECT status, baseline_price FROM public.price_watches WHERE watch_id = ${watch_id}::uuid
  `;
  expect(rows[0]!.status).toBe("active");
  expect(Number(rows[0]!.baseline_price)).toBe(850);
});
