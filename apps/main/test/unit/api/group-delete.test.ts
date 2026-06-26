// §18 — DELETE /api/groups/[id]: coordinator deletes a group, guarded by
// re-typing the sailing date. This covers the route's gating; the actual
// destructive mutations live in hardDeleteGroup (delete-group.test.ts).
//
// Intent under test:
//   1. Wrong sailing date → 400, helper NOT called.
//   2. Correct sailing date → 200, helper called with the group id.
//   3. Caller is not the coordinator → 403, helper NOT called.
//   4. Group not found in caller's tenant → 404, helper NOT called.

import { describe, it, expect, vi, beforeEach } from "vitest";

const COORDINATOR_ID = "user-coord-1";
const OTHER_USER_ID = "user-other-9";
const GROUP_ID = "g-del-1";
const TENANT_ID = "t-1";
const SAILING_DATE = "2027-03-14";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  groupQuery: vi.fn(),
  hardDeleteGroup: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: mocks.groupQuery }) }),
    }),
  }),
}));

vi.mock("@/lib/groups/delete-group", () => ({
  hardDeleteGroup: mocks.hardDeleteGroup,
}));

function delReq(body: unknown): Request {
  return new Request(`http://localhost/api/groups/${GROUP_ID}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PARAMS = { params: Promise.resolve({ id: GROUP_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID },
    user: { id: COORDINATOR_ID },
  });
  mocks.groupQuery.mockResolvedValue({
    data: { id: GROUP_ID, coordinator_user_id: COORDINATOR_ID, sailing_date: SAILING_DATE },
    error: null,
  });
  mocks.hardDeleteGroup.mockResolvedValue(undefined);
});

describe("DELETE /api/groups/[id]", () => {
  it("rejects a wrong sailing date with 400 and deletes nothing", async () => {
    const { DELETE } = await import("@/app/api/groups/[id]/route");
    const res = await DELETE(delReq({ confirm_sailing_date: "2099-01-01" }), PARAMS);

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("sailing_date_mismatch");
    expect(mocks.hardDeleteGroup).not.toHaveBeenCalled();
  });

  it("deletes the group when the sailing date matches", async () => {
    const { DELETE } = await import("@/app/api/groups/[id]/route");
    const res = await DELETE(delReq({ confirm_sailing_date: SAILING_DATE }), PARAMS);

    expect(res.status).toBe(200);
    expect((await res.json() as { deleted: boolean }).deleted).toBe(true);
    expect(mocks.hardDeleteGroup).toHaveBeenCalledWith(GROUP_ID);
  });

  it("returns 403 when the caller is not the coordinator", async () => {
    mocks.assertPermission.mockResolvedValue({
      ctx: { tenant_id: TENANT_ID },
      user: { id: OTHER_USER_ID },
    });
    const { DELETE } = await import("@/app/api/groups/[id]/route");
    const res = await DELETE(delReq({ confirm_sailing_date: SAILING_DATE }), PARAMS);

    expect(res.status).toBe(403);
    expect(mocks.hardDeleteGroup).not.toHaveBeenCalled();
  });

  it("returns 404 when the group is not in the caller's tenant", async () => {
    mocks.groupQuery.mockResolvedValue({ data: null, error: null });
    const { DELETE } = await import("@/app/api/groups/[id]/route");
    const res = await DELETE(delReq({ confirm_sailing_date: SAILING_DATE }), PARAMS);

    expect(res.status).toBe(404);
    expect(mocks.hardDeleteGroup).not.toHaveBeenCalled();
  });
});
