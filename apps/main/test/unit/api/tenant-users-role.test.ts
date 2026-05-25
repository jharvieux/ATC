// §26.2 — Tests for PATCH /api/tenant/users/[id]/role.
//
// Validates the input contract + the cannot-demote-self guard. Auth gating
// (only tenant_owner can edit roles) is enforced by assertPermission against
// the team_members:update_role grant; that's tested via permission-grants.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  updateEqSelectMaybeSingle: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return {
    ...actual,
    assertPermission: mocks.assertPermission,
  };
});

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: () => ({
      update: () => ({
        eq: () => ({
          select: () => ({ maybeSingle: mocks.updateEqSelectMaybeSingle }),
        }),
      }),
    }),
  }),
}));

import { PATCH } from "@/app/api/tenant/users/[id]/role/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: "t-1", source: { kind: "http_request", user_id: "u-self" } },
    user: { id: "u-self", auth_user_id: "auth-self", tenant_id: "t-1", status: "active", role: "tenant_owner" },
  });
});

function makeReq(body: unknown): Request {
  return new Request("http://test/api/tenant/users/u-target/role", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("PATCH /api/tenant/users/[id]/role", () => {
  it("rejects invalid JSON body with 400", async () => {
    const res = await PATCH(makeReq("not-json{"), { params: Promise.resolve({ id: "u-target" }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_json");
  });

  it("rejects missing role with 400", async () => {
    const res = await PATCH(makeReq({}), { params: Promise.resolve({ id: "u-target" }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_role");
  });

  it("rejects unknown role with 400", async () => {
    const res = await PATCH(
      makeReq({ role: "superadmin" }),
      { params: Promise.resolve({ id: "u-target" }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_role");
  });

  it("rejects self-demote with 409", async () => {
    const res = await PATCH(
      makeReq({ role: "viewer" }),
      { params: Promise.resolve({ id: "u-self" }) }, // same as ctx.user.id
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("cannot_demote_self");
  });

  it("returns 404 when target user is not in tenant", async () => {
    mocks.updateEqSelectMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const res = await PATCH(
      makeReq({ role: "agent" }),
      { params: Promise.resolve({ id: "u-other" }) },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("user_not_found_in_tenant");
  });

  it("accepts a valid role change", async () => {
    mocks.updateEqSelectMaybeSingle.mockResolvedValueOnce({
      data: { id: "u-other", role: "agent" },
      error: null,
    });
    const res = await PATCH(
      makeReq({ role: "agent" }),
      { params: Promise.resolve({ id: "u-other" }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; user: { id: string; role: string } };
    expect(body.ok).toBe(true);
    expect(body.user.role).toBe("agent");
  });
});
