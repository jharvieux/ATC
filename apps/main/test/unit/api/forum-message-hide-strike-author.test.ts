// §19.7 — PATCH /api/forums/messages/:id coordinator "hide" action.
//
// Why this test matters (#1572): a message is authored by exactly one of
// user_id/invitation_id (forum_messages_author_xor). Before this fix, the
// hide action always called recordStrike/checkStrikePatterns with
// `user_id: msg.user_id as string` — for a guest-authored message that cast
// a null to a string, and forum_strikes.user_id was NOT NULL, so hiding a
// guest's message threw a constraint-violation error instead of recording a
// strike. This proves both author shapes now resolve correctly.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  recordStrike: vi.fn(),
  checkStrikePatterns: vi.fn(),
  messageMaybeSingle: vi.fn(),
  forumSingle: vi.fn(),
  updateEq: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/forums/strikes", () => ({
  recordStrike: mocks.recordStrike,
  checkStrikePatterns: mocks.checkStrikePatterns,
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "forum_messages") {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: mocks.messageMaybeSingle }) }) }),
          update: () => ({ eq: () => ({ eq: () => mocks.updateEq() }) }),
        };
      }
      if (table === "forums") {
        return { select: () => ({ eq: () => ({ eq: () => ({ single: mocks.forumSingle }) }) }) };
      }
      throw new Error(`unmocked table: ${table}`);
    },
  }),
}));

const CTX = { tenant_id: "t-1" };
const COORD = { id: "coord-1" };

function req(body: unknown) {
  return new Request("https://example.com/api/forums/messages/m1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({ ctx: CTX, user: COORD });
  mocks.forumSingle.mockResolvedValue({
    data: { id: "f1", groups: { coordinator_user_id: "coord-1" } },
    error: null,
  });
  mocks.updateEq.mockResolvedValue({ data: null, error: null });
  mocks.recordStrike.mockResolvedValue(undefined);
  mocks.checkStrikePatterns.mockResolvedValue({ auto_muted: false, coordinator_review_prompt: false, recommend_removal: false });
});

describe("PATCH /api/forums/messages/[id] — hide action strike-authoring (#1572)", () => {
  it("strikes a member-authored message by user_id", async () => {
    mocks.messageMaybeSingle.mockResolvedValue({
      data: { id: "m1", forum_id: "f1", tenant_id: "t-1", user_id: "u-1", invitation_id: null },
      error: null,
    });
    const { PATCH } = await import("@/app/api/forums/messages/[id]/route");

    const res = await PATCH(req({ action: "hide" }), { params: Promise.resolve({ id: "m1" }) });

    expect(res.status).toBe(200);
    expect(mocks.recordStrike).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ author: { user_id: "u-1" }, kind: "coordinator_hidden" }),
    );
  });

  it("strikes a guest-authored message by invitation_id instead of crashing", async () => {
    mocks.messageMaybeSingle.mockResolvedValue({
      data: { id: "m1", forum_id: "f1", tenant_id: "t-1", user_id: null, invitation_id: "inv-1" },
      error: null,
    });
    const { PATCH } = await import("@/app/api/forums/messages/[id]/route");

    const res = await PATCH(req({ action: "hide" }), { params: Promise.resolve({ id: "m1" }) });

    expect(res.status).toBe(200);
    expect(mocks.recordStrike).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ author: { invitation_id: "inv-1" }, kind: "coordinator_hidden" }),
    );
  });
});
