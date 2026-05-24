import { test, expect } from "@playwright/test";

// Smoke test — this one runs for real; does not require app data.
// Shape mirrors apps/main/src/app/api/health/route.ts.
test("health endpoint returns 200 with expected shape", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toEqual({
    status: "ok",
    service: "main",
    commit: expect.any(String),
  });
});
