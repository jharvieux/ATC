import { test, expect } from "@playwright/test";

// Smoke test — this one runs for real; does not require app data
test("health endpoint returns 200 with expected shape", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty("status");
  expect(body).toHaveProperty("timestamp");
  expect(body).toHaveProperty("checks");
});
