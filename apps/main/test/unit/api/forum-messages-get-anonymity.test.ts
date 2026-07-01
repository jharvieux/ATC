// GET /api/forums/:forumId/threads/:threadId/messages — guest anonymity gate.
//
// Why this test matters: a hidden-visibility guest's real invitee_name must
// never reach the response body, for coordinators or anyone else — the route
// derives author_name server-side specifically so the client can't leak it.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  forumMaybeSingle: vi.fn(),
  messagesResult: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "forums") {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: mocks.forumMaybeSingle }) }) }) };
      }
      if (table === "forum_messages") {
        const builder = {
          eq: () => builder,
          order: () => mocks.messagesResult(),
        };
        return { select: () => builder };
      }
      return {};
    },
  }),
}));

import { GET } from "@/app/api/forums/[forumId]/threads/[threadId]/messages/route";

const TENANT_ID = "t-1";
const FORUM_ID = "forum-1";
const THREAD_ID = "thread-1";
const PARAMS = { params: Promise.resolve({ forumId: FORUM_ID, threadId: THREAD_ID }) };

function getReq(): Request {
  return new Request(`https://example.com/api/forums/${FORUM_ID}/threads/${THREAD_ID}/messages`);
}

const HIDDEN_GUEST_MESSAGE = {
  id: "msg-1", content: "hi", status: "visible", user_id: null,
  invitation_id: "inv-1", parent_message_id: null, created_at: "2026-01-01T00:00:00Z",
  invitations: { invitee_name: "Real Name", visibility_choice: "be_anonymous" },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/forums/:forumId/threads/:threadId/messages — anonymity (§19.6)", () => {
  it("coordinator viewing a hidden-visibility guest message sees Anonymous, not the real name", async () => {
    mocks.assertPermission.mockResolvedValue({ ctx: { tenant_id: TENANT_ID }, user: { id: "coord-1" } });
    mocks.forumMaybeSingle.mockResolvedValue({
      data: { tenant_id: TENANT_ID, groups: { coordinator_user_id: "coord-1", visibility_default: "visible" } },
      error: null,
    });
    mocks.messagesResult.mockResolvedValue({ data: [HIDDEN_GUEST_MESSAGE], error: null });

    const res = await GET(getReq(), PARAMS);
    const body = await res.json() as { messages: Array<{ author_name: string | null }> };

    expect(body.messages[0]!.author_name).toBe("Anonymous");
  });

  it("non-coordinator viewing a hidden-visibility guest message sees Anonymous", async () => {
    mocks.assertPermission.mockResolvedValue({ ctx: { tenant_id: TENANT_ID }, user: { id: "member-1" } });
    mocks.forumMaybeSingle.mockResolvedValue({
      data: { tenant_id: TENANT_ID, groups: { coordinator_user_id: "coord-1", visibility_default: "visible" } },
      error: null,
    });
    mocks.messagesResult.mockResolvedValue({ data: [HIDDEN_GUEST_MESSAGE], error: null });

    const res = await GET(getReq(), PARAMS);
    const body = await res.json() as { messages: Array<{ author_name: string | null }> };

    expect(body.messages[0]!.author_name).toBe("Anonymous");
  });

  it("show_me_anyway guest message reveals the real display name", async () => {
    mocks.assertPermission.mockResolvedValue({ ctx: { tenant_id: TENANT_ID }, user: { id: "coord-1" } });
    mocks.forumMaybeSingle.mockResolvedValue({
      data: { tenant_id: TENANT_ID, groups: { coordinator_user_id: "coord-1", visibility_default: "visible" } },
      error: null,
    });
    mocks.messagesResult.mockResolvedValue({
      data: [{ ...HIDDEN_GUEST_MESSAGE, invitations: { invitee_name: "Real Name", visibility_choice: "show_me_anyway" } }],
      error: null,
    });

    const res = await GET(getReq(), PARAMS);
    const body = await res.json() as { messages: Array<{ author_name: string | null }> };

    expect(body.messages[0]!.author_name).toBe("Real N.");
  });
});
