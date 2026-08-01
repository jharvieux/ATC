// #397 / D-091 — bearer-auth gate behavior for the two cron-facing admin
// routes (/api/admin/tenants, /api/admin/platform-settings). Both compare the
// Authorization header against MAIN_APP_ADMIN_API_KEY with constantTimeEqual.
//
// These tests pin the gate's observable behavior (right key → 200, any wrong
// or missing key → 401, unset env → 500). The constant-time swap must not
// change ANY of these outcomes — if it did, the timing fix would have altered
// auth semantics, which is itself a bug.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Both routes pass the gate (200 path) into a service-role query. Stub it so
// the test exercises only the auth gate, not a live Supabase connection. The
// stubbed `select()` is both awaitable (tenants: `await select()`) and chains
// `.order()` (platform-settings: `await select().order()`).
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => {
        const result = { data: [], error: null };
        return {
          order: () => Promise.resolve(result),
          then: (resolve: (v: typeof result) => unknown) => resolve(result),
        };
      },
    }),
  }),
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, MAIN_APP_ADMIN_API_KEY: "service-secret-key" };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function req(headers: Record<string, string>): Request {
  return new Request("http://test/api/admin/x", { headers });
}

async function callTenants(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("@/app/api/admin/tenants/route");
  return GET(req(headers));
}

async function callSettings(headers: Record<string, string>): Promise<Response> {
  const { GET } = await import("@/app/api/admin/platform-settings/route");
  return GET(req(headers));
}

for (const [name, call] of [
  ["tenants", callTenants],
  ["platform-settings", callSettings],
] as const) {
  describe(`/api/admin/${name} — bearer gate (#397)`, () => {
    it("returns 401 when the Authorization header is missing", async () => {
      const res = await call({});
      expect(res.status).toBe(401);
    });

    it("returns 401 for a wrong key of the same length", async () => {
      const res = await call({ Authorization: "Bearer service-wrong-keyy" });
      expect(res.status).toBe(401);
    });

    it("returns 401 for a wrong key of a different length", async () => {
      const res = await call({ Authorization: "Bearer nope" });
      expect(res.status).toBe(401);
    });

    it("returns 200 for the correct bearer key", async () => {
      const res = await call({ Authorization: "Bearer service-secret-key" });
      expect(res.status).toBe(200);
    });

    it("returns 500 when MAIN_APP_ADMIN_API_KEY is unset", async () => {
      delete process.env.MAIN_APP_ADMIN_API_KEY;
      const res = await call({ Authorization: "Bearer service-secret-key" });
      expect(res.status).toBe(500);
    });

    // #2002 / D-091 #28 — the rotation set. A rotation must be possible with
    // zero seam downtime: while _PREVIOUS is configured, callers still holding
    // the old key keep working.
    it("returns 200 for MAIN_APP_ADMIN_API_KEY_CURRENT (legacy var unset)", async () => {
      delete process.env.MAIN_APP_ADMIN_API_KEY;
      process.env.MAIN_APP_ADMIN_API_KEY_CURRENT = "rotated-current-key";
      const res = await call({ Authorization: "Bearer rotated-current-key" });
      expect(res.status).toBe(200);
    });

    it("returns 200 for MAIN_APP_ADMIN_API_KEY_PREVIOUS during rotation overlap", async () => {
      delete process.env.MAIN_APP_ADMIN_API_KEY;
      process.env.MAIN_APP_ADMIN_API_KEY_CURRENT = "rotated-current-key";
      process.env.MAIN_APP_ADMIN_API_KEY_PREVIOUS = "old-previous-key";
      const res = await call({ Authorization: "Bearer old-previous-key" });
      expect(res.status).toBe(200);
    });

    it("returns 401 for a wrong key when the full rotation set is configured", async () => {
      process.env.MAIN_APP_ADMIN_API_KEY_CURRENT = "rotated-current-key";
      process.env.MAIN_APP_ADMIN_API_KEY_PREVIOUS = "old-previous-key";
      const res = await call({ Authorization: "Bearer neither-of-those" });
      expect(res.status).toBe(401);
    });
  });
}
