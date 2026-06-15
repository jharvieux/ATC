// #783 Phase 3 — POST /api/groups sailing_id FK forwarding.
//
// The cascade-dropdown UX passes sailing_id when the coordinator selects a
// sailing from the catalog. This test pins the contract: sailing_id from the
// body reaches the groups INSERT when present, and is absent when omitted
// (the legacy free-text path must not accidentally null-write the FK).

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_ID = "t-group-create";
const GROUP_ID = "g-group-create";
const SAILING_ID = "sail-uuid-abc";

const groupInsert = vi.fn();

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  resolveCanonical: vi.fn(),
  selectHeroImage: vi.fn(),
  loadTenantSnapshot: vi.fn(),
  incrementGroupInvitees: vi.fn(),
  generateToken: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/canonical/resolve-canonical", () => ({
  resolveCanonical: mocks.resolveCanonical,
}));

vi.mock("@/lib/groups/hero-image", () => ({
  selectHeroImage: mocks.selectHeroImage,
}));

vi.mock("@/lib/abuse/snapshot", () => ({
  loadTenantSnapshot: mocks.loadTenantSnapshot,
}));

vi.mock("@/lib/abuse/counters", () => ({
  incrementGroupInvitees: mocks.incrementGroupInvitees,
}));

vi.mock("@/lib/groups/invitation-token", () => ({
  generateToken: mocks.generateToken,
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "groups") {
        return {
          insert: (row: Record<string, unknown>) => {
            groupInsert(row);
            return {
              select: () => ({
                single: async () => ({ data: { id: GROUP_ID }, error: null }),
              }),
            };
          },
        };
      }
      // invitations table
      return { insert: () => Promise.resolve({ error: null }) };
    },
  }),
}));

function postReq(body: unknown): Request {
  return new Request("http://localhost/api/groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const BASE_BODY = {
  cruise_line: "Norwegian Cruise Line",
  ship_name: "Norwegian Prima",
  sailing_date: "2026-08-15",
  departure_port: "Seattle",
  invitees: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  groupInsert.mockClear();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID },
    user: { id: "u-1" },
  });
  mocks.resolveCanonical.mockResolvedValue({ matched: false });
  mocks.selectHeroImage.mockResolvedValue(null);
  mocks.loadTenantSnapshot.mockResolvedValue({ tenant: { id: TENANT_ID } });
  mocks.incrementGroupInvitees.mockResolvedValue(undefined);
  mocks.generateToken.mockReturnValue("tok-stub");
});

describe("POST /api/groups — sailing_id FK (#783)", () => {
  it("includes sailing_id in the groups INSERT when provided by the cascade-dropdown", async () => {
    const { POST } = await import("@/app/api/groups/route");
    const res = await POST(postReq({ ...BASE_BODY, sailing_id: SAILING_ID }));

    expect(res.status).toBe(201);
    expect(groupInsert).toHaveBeenCalledTimes(1);
    const row = groupInsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.sailing_id).toBe(SAILING_ID);
  });

  it("omits sailing_id from the groups INSERT when the legacy free-text path is used (no catalog)", async () => {
    const { POST } = await import("@/app/api/groups/route");
    const res = await POST(postReq(BASE_BODY));

    expect(res.status).toBe(201);
    expect(groupInsert).toHaveBeenCalledTimes(1);
    const row = groupInsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row).not.toHaveProperty("sailing_id");
  });
});
