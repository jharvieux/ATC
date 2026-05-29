// #394 / D-091 — duplicate-action `cancel` needs a CAS row-count assert.
//
// The cancel branch updates review_status='superseded' guarded by
// .eq("review_status","ready_for_review"). supabase-js returns { error: null }
// whether the row matched or a concurrent review decision already moved it, so
// without .select("id") + count the route answered { status: "superseded" } on
// a zero-row no-op. These tests pin that a concurrent change now surfaces 409.

import { describe, it, expect, vi, beforeEach } from "vitest";

type Result = { data: { id: string }[] | null; error: { message: string } | null };
type Chain = {
  update: () => Chain;
  eq: () => Chain;
  select: () => Promise<Result>;
};

const mocks = vi.hoisted(() => ({
  result: { data: [{ id: "sub-1" }], error: null } as Result,
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => ({ ctx: { tenant_id: "t-1" }, user: { id: "u-1" } })),
}));

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: vi.fn(() => {
    const chain: Chain = {
      update: () => chain,
      eq: () => chain,
      select: () => Promise.resolve(mocks.result),
    };
    return { from: () => chain };
  }),
}));

vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: (e: unknown) => Response.json({ error: String(e) }, { status: 401 }),
}));

vi.mock("@/lib/rag-auth/sign-service-jwt", () => ({
  signServiceJwt: async () => "jwt-token",
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.result = { data: [{ id: "sub-1" }], error: null };
});

async function callCancel(): Promise<Response> {
  const { POST } = await import("@/app/api/rag/queue/[id]/duplicate-action/route");
  return POST(
    new Request("http://test/api/rag/queue/sub-1/duplicate-action", {
      method: "POST",
      body: JSON.stringify({ mode: "cancel" }),
    }),
    { params: Promise.resolve({ id: "sub-1" }) },
  );
}

describe("duplicate-action cancel — CAS row-count assert (#394)", () => {
  it("returns 409 when no row is still ready_for_review (concurrent decision won)", async () => {
    mocks.result = { data: [], error: null };
    const res = await callCancel();
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "not_in_reviewable_state" });
  });

  it("returns 200 { status: superseded } when exactly one row matched (happy path)", async () => {
    mocks.result = { data: [{ id: "sub-1" }], error: null };
    const res = await callCancel();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "superseded" });
  });

  it("returns 500 on a real DB error rather than a false success", async () => {
    mocks.result = { data: null, error: { message: "db boom" } };
    const res = await callCancel();
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "db boom" });
  });
});
