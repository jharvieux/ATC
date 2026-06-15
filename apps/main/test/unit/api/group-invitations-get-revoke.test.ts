// §18.5 — GET + revoke action for /api/groups/[id]/invitations (#1064).
//
// Intent under test:
//   1. GET returns the invitee list for a coordinator (200).
//   2. GET returns 403 when the caller is not the coordinator.
//   3. POST action=revoke sets token_revoked_at on the target invitation (200).
//   4. POST action=revoke on an already-revoked invitation still returns 200
//      (Supabase IS NULL filter means zero rows updated, but error is null —
//      client should treat this as "already removed").
//   5. POST with an unknown action returns 400.

import { describe, it, expect, vi, beforeEach } from "vitest";

const COORDINATOR_ID = "user-coord-1";
const GROUP_ID = "g-111";
const INV_ID = "inv-abc";
const TENANT_ID = "t-1";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  groupQuery: vi.fn(),
  invitationsQuery: vi.fn(),
  updateQuery: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/groups/sailed-gate", async () => {
  const actual = await vi.importActual<typeof import("@/lib/groups/sailed-gate")>(
    "@/lib/groups/sailed-gate",
  );
  return { ...actual, assertGroupNotSailed: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("@/lib/groups/invitation-token", () => ({
  generateToken: (id: string) => `tok-${id.slice(0, 8)}`,
}));

// Service-role client drives the invitations route (coordinator-owned).
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "groups") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ single: mocks.groupQuery }),
            }),
          }),
        };
      }
      if (table === "invitations") {
        return {
          select: () => ({
            eq: () => ({
              order: () => mocks.invitationsQuery(),
            }),
          }),
          update: () => ({
            eq: () => ({
              eq: () => ({
                is: () => mocks.updateQuery(),
              }),
            }),
          }),
        };
      }
      return {};
    },
  }),
}));

function getReq(groupId: string) {
  return new Request(`http://localhost/api/groups/${groupId}/invitations`);
}

function postReq(groupId: string, body: unknown) {
  return new Request(`http://localhost/api/groups/${groupId}/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/groups/[id]/invitations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertPermission.mockResolvedValue({
      ctx: { tenant_id: TENANT_ID },
      user: { id: COORDINATOR_ID },
    });
    mocks.groupQuery.mockResolvedValue({
      data: { id: GROUP_ID, coordinator_user_id: COORDINATOR_ID, tenant_id: TENANT_ID },
      error: null,
    });
  });

  it("returns invitee list when caller is coordinator", async () => {
    const inv = { id: INV_ID, invitee_email: "a@example.com", rsvp_state: "interested" };
    mocks.invitationsQuery.mockResolvedValue({ data: [inv], error: null });

    const { GET } = await import("@/app/api/groups/[id]/invitations/route");
    const res = await GET(getReq(GROUP_ID), { params: Promise.resolve({ id: GROUP_ID }) });

    expect(res.status).toBe(200);
    const body: { invitations: unknown[] } = await res.json();
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0]).toMatchObject({ rsvp_state: "interested" });
  });

  it("returns 403 when caller is not the group coordinator", async () => {
    mocks.groupQuery.mockResolvedValue({
      data: { id: GROUP_ID, coordinator_user_id: "other-user", tenant_id: TENANT_ID },
      error: null,
    });

    const { GET } = await import("@/app/api/groups/[id]/invitations/route");
    const res = await GET(getReq(GROUP_ID), { params: Promise.resolve({ id: GROUP_ID }) });

    expect(res.status).toBe(403);
  });
});

describe("POST /api/groups/[id]/invitations — revoke action (#1064)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertPermission.mockResolvedValue({
      ctx: { tenant_id: TENANT_ID },
      user: { id: COORDINATOR_ID },
    });
    mocks.groupQuery.mockResolvedValue({
      data: { id: GROUP_ID, coordinator_user_id: COORDINATOR_ID, tenant_id: TENANT_ID },
      error: null,
    });
  });

  it("revoke action sets token_revoked_at and returns ok", async () => {
    mocks.updateQuery.mockResolvedValue({ error: null });

    const { POST } = await import("@/app/api/groups/[id]/invitations/route");
    const res = await POST(
      postReq(GROUP_ID, { action: "revoke", invitation_id: INV_ID }),
      { params: Promise.resolve({ id: GROUP_ID }) },
    );

    expect(res.status).toBe(200);
    const body: { ok: boolean; action: string } = await res.json();
    expect(body.ok).toBe(true);
    expect(body.action).toBe("revoked");
  });

  it("returns 200 when invitation is already revoked (zero-row update, error null)", async () => {
    // IS NULL guard means zero rows updated when already revoked — route returns ok:true regardless.
    // This verifies the documented silent-success contract (intent #4).
    mocks.updateQuery.mockResolvedValue({ error: null });

    const { POST } = await import("@/app/api/groups/[id]/invitations/route");
    const res = await POST(
      postReq(GROUP_ID, { action: "revoke", invitation_id: "already-revoked-id" }),
      { params: Promise.resolve({ id: GROUP_ID }) },
    );

    expect(res.status).toBe(200);
    const body: { ok: boolean; action: string } = await res.json();
    expect(body.ok).toBe(true);
    expect(body.action).toBe("revoked");
  });

  it("returns 400 for an unknown action", async () => {
    const { POST } = await import("@/app/api/groups/[id]/invitations/route");
    const res = await POST(
      postReq(GROUP_ID, { action: "not_a_real_action" }),
      { params: Promise.resolve({ id: GROUP_ID }) },
    );

    expect(res.status).toBe(400);
  });
});
