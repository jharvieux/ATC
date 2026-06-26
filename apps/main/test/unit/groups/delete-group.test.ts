// §18 — hardDeleteGroup clears the two non-cascading inbound FK refs and then
// hard-deletes the group (invitations + forums cascade in the DB). The order and
// the exact filters matter: an unfiltered delete would be catastrophic.

import { describe, it, expect, vi, beforeEach } from "vitest";

const GROUP_ID = "g-del-1";

const mocks = vi.hoisted(() => ({
  emailLogUpdateEq: vi.fn(),
  pendingDeleteEq: vi.fn(),
  groupDeleteEq: vi.fn(),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "email_log") return { update: () => ({ eq: mocks.emailLogUpdateEq }) };
      if (table === "group_invite_pending_approval") return { delete: () => ({ eq: mocks.pendingDeleteEq }) };
      if (table === "groups") return { delete: () => ({ eq: mocks.groupDeleteEq }) };
      return {};
    },
  }),
}));

// safeAwait just needs to resolve — the builder chains record their calls when evaluated.
vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: vi.fn().mockResolvedValue([]),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emailLogUpdateEq.mockResolvedValue({ error: null });
  mocks.pendingDeleteEq.mockResolvedValue({ error: null });
  mocks.groupDeleteEq.mockResolvedValue({ error: null });
});

describe("hardDeleteGroup", () => {
  it("unlinks email_log, deletes pending-approval rows, and deletes the group — each scoped to the group id", async () => {
    const { hardDeleteGroup } = await import("@/lib/groups/delete-group");
    await hardDeleteGroup(GROUP_ID);

    expect(mocks.emailLogUpdateEq).toHaveBeenCalledWith("related_group_id", GROUP_ID);
    expect(mocks.pendingDeleteEq).toHaveBeenCalledWith("group_id", GROUP_ID);
    expect(mocks.groupDeleteEq).toHaveBeenCalledWith("id", GROUP_ID);
  });
});
