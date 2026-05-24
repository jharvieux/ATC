import { test, expect } from "@playwright/test";

// BP40 §33.8 — price-watch API e2e.
//
// Tier-2 limitation: the full create/list/cancel flow needs PostgREST
// in front of local Postgres so the Supabase JS client in tenantClient()
// can talk to the DB. The cases below stop at the first guard that
// doesn't require a DB read so they can run against bare Postgres +
// the auth bypass alone. Filling in the rest is Tier-2.5 (run
// `postgrest` against atc_main_test, set NEXT_PUBLIC_SUPABASE_URL).

const BYPASS = process.env.TEST_AUTH_BYPASS_TOKEN ?? "tier2-local-test-secret";
const TENANT = process.env.TEST_AUTH_BYPASS_TENANT_ID ?? "22222222-0000-0000-0000-0000000000a1";

const VALID_REQUEST_HEADERS = {
  Authorization: `Bearer ${BYPASS}`,
  "x-resolved-tenant-id": TENANT,
  "Content-Type": "application/json",
};

const VALID_BODY = {
  cruise_line: "RCL",
  ship: "symphony-of-the-seas",
  sail_date: "2026-08-15",
  departure_port: "MIA",
  cabin_class: "interior",
  threshold_kind: "dollar_drop",
  dollar_threshold: 100,
};

test("POST /api/price-watches requires auth", async ({ request }) => {
  // No bypass token → goes through real auth path → 401-ish error.
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
    data: { cruise_line: "RCL" }, // missing required fields
  });
  expect(res.status()).toBe(400);
  const json = await res.json();
  expect(json.error).toBe("invalid_request");
});

test("POST /api/price-watches returns 422 uncovered_line for unsupported cruise line", async ({ request }) => {
  const res = await request.post("/api/price-watches", {
    headers: VALID_REQUEST_HEADERS,
    data: { ...VALID_BODY, cruise_line: "BCK" }, // BCK is in routes but enabled:false
  });
  expect(res.status()).toBe(422);
  const json = await res.json();
  expect(json.error).toBe("uncovered_line");
});

// Tier-2.5 follow-ups (need PostgREST running for tenantClient() DB queries):
test.skip("POST /api/price-watches returns 422 price_data_unavailable when cache empty", async () => {});
test.skip("POST /api/price-watches creates a watch and returns watch_id", async () => {});
test.skip("GET  /api/price-watches lists caller's watches", async () => {});
test.skip("PATCH /api/price-watches/[id] pauses a watch", async () => {});
test.skip("POST  /api/price-watches/[id]/rearm resets baseline", async () => {});
