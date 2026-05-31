import { test, expect } from "@playwright/test";
import { HEADERS, HEADERS_NO_AUTH } from "./_helpers";

// §7.6 — /api/bookings/draft. Stub (501) but auth-gated.

test("POST /api/bookings/draft without auth → 401", async ({ request }) => {
  const res = await request.post("/api/bookings/draft", {
    headers: HEADERS_NO_AUTH,
    data: {},
  });
  expect(res.status()).toBe(401);
});

test("POST /api/bookings/draft with bypass → past the auth gate", async ({ request }) => {
  const res = await request.post("/api/bookings/draft", {
    headers: HEADERS,
    data: {},
  });
  expect([200, 201, 501]).toContain(res.status());
});

// TODO(#424): booking create and detail routes still 501; wire E2E when Stage 2/3 ships.
test.fixme("create a new booking succeeds", async () => {});
test.fixme("booking list shows at least one booking after creation", async () => {});
test.fixme("booking detail page loads for a valid booking", async () => {});
