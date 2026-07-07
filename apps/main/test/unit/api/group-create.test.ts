// #783 Phase 3 — POST /api/groups sailing_id FK forwarding.
//
// The cascade-dropdown UX passes sailing_id when the coordinator selects a
// sailing from the catalog. This test pins the contract: sailing_id from the
// body reaches the groups INSERT when present, and is absent when omitted
// (the legacy free-text path must not accidentally null-write the FK).

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_ID = "t-group-create";
const GROUP_ID = "g-group-create";
const SAILING_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

const groupInsert = vi.fn();
const forumInsert = vi.fn();
const groupDelete = vi.fn();
let invitationsInsertError: { message: string; code?: string } | null = null;
let groupDeleteError: { message: string } | null = null;

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  resolveCanonical: vi.fn(),
  selectHeroImage: vi.fn(),
  loadTenantSnapshot: vi.fn(),
  incrementGroupInvitees: vi.fn(),
  generateToken: vi.fn(),
  sendGroupInvitationEmail: vi.fn(),
}));

vi.mock("@/lib/groups/send-invitation-email", () => ({
  sendGroupInvitationEmail: mocks.sendGroupInvitationEmail,
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
  evictTenantSnapshot: () => {},
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
          delete: () => ({
            eq: (_col: string, id: string) => {
              groupDelete(id);
              return { eq: () => Promise.resolve({ error: groupDeleteError }) };
            },
          }),
        };
      }
      if (table === "forums") {
        return {
          insert: (row: Record<string, unknown>) => {
            forumInsert(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      // invitations table
      return { insert: () => Promise.resolve({ error: invitationsInsertError }) };
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
  forumInsert.mockClear();
  groupDelete.mockClear();
  invitationsInsertError = null;
  groupDeleteError = null;
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID },
    user: { id: "u-1" },
  });
  mocks.resolveCanonical.mockResolvedValue({ matched: false });
  mocks.selectHeroImage.mockResolvedValue(null);
  mocks.loadTenantSnapshot.mockResolvedValue({ tenant: { id: TENANT_ID } });
  mocks.incrementGroupInvitees.mockResolvedValue(undefined);
  mocks.generateToken.mockReturnValue("tok-stub");
  mocks.sendGroupInvitationEmail.mockResolvedValue(undefined);
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

  it("returns 400 when sailing_id is present but not a valid UUID", async () => {
    const { POST } = await import("@/app/api/groups/route");
    const res = await POST(postReq({ ...BASE_BODY, sailing_id: "not-a-uuid" }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("UUID");
    expect(groupInsert).not.toHaveBeenCalled();
  });
});

describe("POST /api/groups — immediate invitations", () => {
  // Create-time invitees must be emailed now, not only by the daily reminder cron.
  it("sends an invitation email per invitee at creation", async () => {
    const { POST } = await import("@/app/api/groups/route");
    const res = await POST(postReq({
      ...BASE_BODY,
      invitees: [{ email: "a@example.com" }, { email: "b@example.com", name: "Bee" }],
    }));

    expect(res.status).toBe(201);
    expect(mocks.sendGroupInvitationEmail).toHaveBeenCalledTimes(2);
    const sentTo = mocks.sendGroupInvitationEmail.mock.calls.map(
      (c) => (c[0] as { invitationId: string }).invitationId,
    );
    expect(new Set(sentTo).size).toBe(2); // one send per distinct invitation
  });

  it("sends no invitation emails when there are no invitees", async () => {
    const { POST } = await import("@/app/api/groups/route");
    const res = await POST(postReq(BASE_BODY));
    expect(res.status).toBe(201);
    expect(mocks.sendGroupInvitationEmail).not.toHaveBeenCalled();
  });
});

describe("POST /api/groups — forum lifecycle", () => {
  // Without a forum row the group's Forum tab 404s — the forum GET route only
  // reads, so creation must write the row.
  it("creates the group's forum row scoped to the tenant", async () => {
    const { POST } = await import("@/app/api/groups/route");
    const res = await POST(postReq(BASE_BODY));

    expect(res.status).toBe(201);
    expect(forumInsert).toHaveBeenCalledTimes(1);
    const row = forumInsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.tenant_id).toBe(TENANT_ID);
    expect(row.group_id).toBeDefined();
  });
});

describe("POST /api/groups — invitations-insert failure cleanup (#1600)", () => {
  // A failed invitations insert previously left the group row `status:'active'`
  // with zero invitees — an orphan a coordinator's retry would duplicate.
  it("deletes the just-created group when the invitations insert fails", async () => {
    invitationsInsertError = { message: "insert failed", code: "23502" };

    const { POST } = await import("@/app/api/groups/route");
    const res = await POST(postReq({ ...BASE_BODY, invitees: [{ email: "a@example.com" }] }));

    expect(res.status).toBe(500);
    expect(groupDelete).toHaveBeenCalledWith(GROUP_ID);
  });

  it("still returns the db-error response if the compensating delete itself fails", async () => {
    invitationsInsertError = { message: "insert failed", code: "23502" };
    groupDeleteError = { message: "delete failed" };

    const { POST } = await import("@/app/api/groups/route");
    const res = await POST(postReq({ ...BASE_BODY, invitees: [{ email: "a@example.com" }] }));

    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("db_error");
  });

  it("does not attempt a compensating delete when there are no invitees to insert", async () => {
    const { POST } = await import("@/app/api/groups/route");
    const res = await POST(postReq(BASE_BODY));

    expect(res.status).toBe(201);
    expect(groupDelete).not.toHaveBeenCalled();
  });
});
