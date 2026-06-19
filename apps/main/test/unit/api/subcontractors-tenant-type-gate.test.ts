// §14.3a (D-272) — Subcontractor tracking is available to BOTH sub_host and
// byo_host tenants; the platform's own agency and any unknown tenant_type are
// denied (fail-closed allowlist).
//
// Intent under test: this is the enforcement point for the product decision to
// open subcontractor bookkeeping to BYO agencies. If someone reverts the gate
// to sub_host-only, the byo_host cases below must fail — that's the whole point
// of the change. The platform/unknown cases guard against the allowlist
// silently widening into a denylist.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  tenantTypeSingle: vi.fn(),
  listResult: vi.fn(),
  insertSingle: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ single: mocks.tenantTypeSingle }),
      }),
    }),
  }),
}));

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: () => ({
      select: () => ({
        is: () => ({ order: mocks.listResult }),
      }),
      insert: () => ({
        select: () => ({ single: mocks.insertSingle }),
      }),
    }),
  }),
}));

import { GET, POST } from "@/app/api/subcontractors/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: "t-1" },
    user: { id: "u-owner", role: "tenant_owner" },
  });
  mocks.listResult.mockResolvedValue({ data: [], error: null });
  mocks.insertSingle.mockResolvedValue({
    data: { id: "sc-1", name: "Sarah", share_rate: 0.5, created_at: "2026-06-19T00:00:00Z" },
    error: null,
  });
});

function getReq(): Request {
  return new Request("http://test/api/subcontractors");
}

function postReq(body: unknown): Request {
  return new Request("http://test/api/subcontractors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/subcontractors — tenant_type gating", () => {
  it.each(["sub_host", "byo_host"])("allows %s", async (tt) => {
    mocks.tenantTypeSingle.mockResolvedValue({ data: { tenant_type: tt } });
    const res = await GET(getReq());
    expect(res.status).toBe(200);
  });

  it.each(["platform", "byo_research", "something_new"])("denies %s with 403", async (tt) => {
    mocks.tenantTypeSingle.mockResolvedValue({ data: { tenant_type: tt } });
    const res = await GET(getReq());
    expect(res.status).toBe(403);
  });

  it("denies when the tenant row is missing (fail-closed)", async () => {
    mocks.tenantTypeSingle.mockResolvedValue({ data: null });
    const res = await GET(getReq());
    expect(res.status).toBe(403);
  });
});

describe("POST /api/subcontractors — tenant_type gating", () => {
  it("lets a byo_host create a subcontractor (201)", async () => {
    mocks.tenantTypeSingle.mockResolvedValue({ data: { tenant_type: "byo_host" } });
    const res = await POST(postReq({ name: "Sarah", share_rate: 0.5 }));
    expect(res.status).toBe(201);
    expect(mocks.insertSingle).toHaveBeenCalled();
  });

  it("blocks the platform agency before any write (403, no insert)", async () => {
    mocks.tenantTypeSingle.mockResolvedValue({ data: { tenant_type: "platform" } });
    const res = await POST(postReq({ name: "Sarah", share_rate: 0.5 }));
    expect(res.status).toBe(403);
    expect(mocks.insertSingle).not.toHaveBeenCalled();
  });
});
