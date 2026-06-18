// Unit tests for consent and consent-status stub routes.
//
// Both routes are planned stubs that return 501. Tests pin:
//   1. The auth gate fires before the 501 — an unauthed caller gets 403,
//      not 501 (auth gate is not bypassed by stub status).
//   2. An authed caller gets 501 (the stub response) so we know the
//      route is reached.
//
// 20 NoCoverage mutants in Stryker — these routes had no tests at all.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  permFails: false,
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: async () => {
    if (h.permFails) throw new Error("forbidden");
    return {
      ctx: { tenant_id: "t1", source: { kind: "http_request" as const, user_id: "u1" } },
      user: { id: "user-1", auth_user_id: "u1", tenant_id: "t1", status: "active", role: "tenant_owner" },
    };
  },
}));

vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: () => Response.json({ error: "auth" }, { status: 403 }),
}));

function req(method: "GET" | "POST"): Request {
  return new Request("https://app.example.com/api/auth/consent", { method });
}

beforeEach(() => {
  h.permFails = false;
});

describe("POST /api/auth/consent", () => {
  it("returns 403 when auth fails (auth gate fires before 501)", async () => {
    h.permFails = true;
    const { POST } = await import("@/app/api/auth/consent/route");
    const res = await POST(req("POST"));
    expect(res.status).toBe(403);
  });

  it("returns 501 when authed (stub endpoint — not yet implemented)", async () => {
    const { POST } = await import("@/app/api/auth/consent/route");
    const res = await POST(req("POST"));
    expect(res.status).toBe(501);
  });
});

describe("GET /api/auth/consent-status", () => {
  it("returns 403 when auth fails (auth gate fires before 501)", async () => {
    h.permFails = true;
    const { GET } = await import("@/app/api/auth/consent-status/route");
    const res = await GET(req("GET"));
    expect(res.status).toBe(403);
  });

  it("returns 501 when authed (stub endpoint — not yet implemented)", async () => {
    const { GET } = await import("@/app/api/auth/consent-status/route");
    const res = await GET(req("GET"));
    expect(res.status).toBe(501);
  });
});
