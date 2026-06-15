// §19.7 — Forum threads + messages read API (#1063).
//
// Intent under test:
//   1. GET /api/groups/:id/forum returns forum_id + is_locked + is_coordinator.
//   2. GET /api/groups/:id/forum returns 404 when the group has no forum.
//   3. GET /api/forums/:forumId/threads returns thread list (non-deleted).
//   4. GET /api/forums/:forumId/threads returns 404 when forum not found.
//   5. POST /api/forums/:forumId/threads creates a thread (201).
//   6. POST /api/forums/:forumId/threads returns 400 when title is missing.
//   7. POST /api/forums/:forumId/threads returns 403 when forum is locked.
//   8. GET /api/forums/:forumId/threads/:threadId/messages returns all statuses for coordinator.
//   9. GET /api/forums/:forumId/threads/:threadId/messages filters to visible for non-coordinator.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_ID = "t-1";
const USER_ID = "u-coord";
const GROUP_ID = "g-1";
const FORUM_ID = "f-1";
const THREAD_ID = "th-1";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  forumQuery: vi.fn(),
  threadsQuery: vi.fn(),
  threadInsert: vi.fn(),
  messagesQuery: vi.fn(),
  messagesEqSpy: vi.fn(),
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
      select: () => ({
        eq: () => ({
          maybeSingle: mocks.forumQuery,
        }),
      }),
    }),
  }),
}));

// Service-role client dispatches on table name.
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "forums") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: mocks.forumQuery,
              }),
            }),
          }),
        };
      }
      if (table === "forum_threads") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                is: () => ({
                  order: () => ({
                    order: mocks.threadsQuery,
                  }),
                }),
              }),
            }),
          }),
          insert: () => ({
            select: () => ({
              single: mocks.threadInsert,
            }),
          }),
        };
      }
      if (table === "forum_messages") {
        // Self-referential chain: .eq() records calls so tests can assert the
        // status="visible" filter is applied for non-coordinators; .order() is terminal.
        const msgChain: Record<string, unknown> = {};
        msgChain.eq = (col: string, val: unknown) => { mocks.messagesEqSpy(col, val); return msgChain; };
        msgChain.order = mocks.messagesQuery;
        return { select: () => msgChain };
      }
      return {};
    },
  }),
}));

const CTX = { tenant_id: TENANT_ID };

function makeReq(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, init);
}

// ─── GET /api/groups/:id/forum ────────────────────────────────────────────

describe("GET /api/groups/[id]/forum", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertPermission.mockResolvedValue({ ctx: CTX, user: { id: USER_ID } });
  });

  it("returns forum_id, is_locked, is_coordinator=true for the coordinator", async () => {
    mocks.forumQuery.mockResolvedValue({
      data: { id: FORUM_ID, is_locked: false, coordinator_user_id: USER_ID },
      error: null,
    });

    const { GET } = await import("@/app/api/groups/[id]/forum/route");
    const res = await GET(makeReq(`/api/groups/${GROUP_ID}/forum`), {
      params: Promise.resolve({ id: GROUP_ID }),
    });

    expect(res.status).toBe(200);
    const body: { forum_id: string; is_locked: boolean; is_coordinator: boolean } = await res.json();
    expect(body.forum_id).toBe(FORUM_ID);
    expect(body.is_coordinator).toBe(true);
  });

  it("returns is_coordinator=false for a non-coordinator", async () => {
    mocks.forumQuery.mockResolvedValue({
      data: { id: FORUM_ID, is_locked: false, coordinator_user_id: "other-user" },
      error: null,
    });

    const { GET } = await import("@/app/api/groups/[id]/forum/route");
    const res = await GET(makeReq(`/api/groups/${GROUP_ID}/forum`), {
      params: Promise.resolve({ id: GROUP_ID }),
    });

    expect(res.status).toBe(200);
    const body: { is_coordinator: boolean } = await res.json();
    expect(body.is_coordinator).toBe(false);
  });

  it("returns 404 when no forum exists for the group", async () => {
    mocks.forumQuery.mockResolvedValue({ data: null, error: null });

    const { GET } = await import("@/app/api/groups/[id]/forum/route");
    const res = await GET(makeReq(`/api/groups/${GROUP_ID}/forum`), {
      params: Promise.resolve({ id: GROUP_ID }),
    });

    expect(res.status).toBe(404);
  });
});

// ─── GET /api/forums/:forumId/threads ────────────────────────────────────

describe("GET /api/forums/[forumId]/threads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertPermission.mockResolvedValue({ ctx: CTX, user: { id: USER_ID } });
    // Forum lookup passes
    mocks.forumQuery.mockResolvedValue({
      data: { id: FORUM_ID, tenant_id: TENANT_ID },
      error: null,
    });
  });

  it("returns thread list", async () => {
    const thread = { id: THREAD_ID, title: "Packing tips", is_locked: false, is_pinned: false, is_announcement: false, created_at: "2026-01-01T00:00:00Z" };
    mocks.threadsQuery.mockResolvedValue({ data: [thread], error: null });

    const { GET } = await import("@/app/api/forums/[forumId]/threads/route");
    const res = await GET(makeReq(`/api/forums/${FORUM_ID}/threads`), {
      params: Promise.resolve({ forumId: FORUM_ID }),
    });

    expect(res.status).toBe(200);
    const body: { threads: unknown[] } = await res.json();
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0]).toMatchObject({ title: "Packing tips" });
  });

  it("returns 404 when forum not found", async () => {
    mocks.forumQuery.mockResolvedValue({ data: null, error: null });

    const { GET } = await import("@/app/api/forums/[forumId]/threads/route");
    const res = await GET(makeReq(`/api/forums/no-such-forum/threads`), {
      params: Promise.resolve({ forumId: "no-such-forum" }),
    });

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/forums/:forumId/threads ───────────────────────────────────

describe("POST /api/forums/[forumId]/threads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertPermission.mockResolvedValue({ ctx: CTX, user: { id: USER_ID } });
  });

  it("creates a thread and returns 201", async () => {
    mocks.forumQuery.mockResolvedValue({
      data: { id: FORUM_ID, is_locked: false, tenant_id: TENANT_ID },
      error: null,
    });
    const created = { id: THREAD_ID, title: "Welcome aboard", forum_id: FORUM_ID };
    mocks.threadInsert.mockResolvedValue({ data: created, error: null });

    const { POST } = await import("@/app/api/forums/[forumId]/threads/route");
    const res = await POST(
      makeReq(`/api/forums/${FORUM_ID}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Welcome aboard" }),
      }),
      { params: Promise.resolve({ forumId: FORUM_ID }) },
    );

    expect(res.status).toBe(201);
    const body: { title: string } = await res.json();
    expect(body.title).toBe("Welcome aboard");
  });

  it("returns 400 when title is missing", async () => {
    mocks.forumQuery.mockResolvedValue({
      data: { id: FORUM_ID, is_locked: false, tenant_id: TENANT_ID },
      error: null,
    });

    const { POST } = await import("@/app/api/forums/[forumId]/threads/route");
    const res = await POST(
      makeReq(`/api/forums/${FORUM_ID}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "  " }),
      }),
      { params: Promise.resolve({ forumId: FORUM_ID }) },
    );

    expect(res.status).toBe(400);
  });

  it("returns 403 when forum is locked", async () => {
    mocks.forumQuery.mockResolvedValue({
      data: { id: FORUM_ID, is_locked: true, tenant_id: TENANT_ID },
      error: null,
    });

    const { POST } = await import("@/app/api/forums/[forumId]/threads/route");
    const res = await POST(
      makeReq(`/api/forums/${FORUM_ID}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Should be blocked" }),
      }),
      { params: Promise.resolve({ forumId: FORUM_ID }) },
    );

    expect(res.status).toBe(403);
  });
});

// ─── GET /api/forums/:forumId/threads/:threadId/messages ─────────────────

describe("GET /api/forums/[forumId]/threads/[threadId]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertPermission.mockResolvedValue({ ctx: CTX, user: { id: USER_ID } });
  });

  it("returns all message statuses for the coordinator", async () => {
    // Forum: user IS coordinator.
    mocks.forumQuery.mockResolvedValue({
      data: { coordinator_user_id: USER_ID, tenant_id: TENANT_ID },
      error: null,
    });
    const msgs = [
      { id: "m1", content: "Hi", status: "visible", user_id: "u2", parent_message_id: null, created_at: "2026-01-01T00:00:00Z" },
      { id: "m2", content: "Bad", status: "hidden", user_id: "u3", parent_message_id: null, created_at: "2026-01-02T00:00:00Z" },
    ];
    mocks.messagesQuery.mockResolvedValue({ data: msgs, error: null });

    const { GET } = await import("@/app/api/forums/[forumId]/threads/[threadId]/messages/route");
    const res = await GET(
      makeReq(`/api/forums/${FORUM_ID}/threads/${THREAD_ID}/messages`),
      { params: Promise.resolve({ forumId: FORUM_ID, threadId: THREAD_ID }) },
    );

    expect(res.status).toBe(200);
    const body: { messages: unknown[]; is_coordinator: boolean } = await res.json();
    expect(body.is_coordinator).toBe(true);
    expect(body.messages).toHaveLength(2);
    // Coordinator path must NOT add a status filter.
    expect(mocks.messagesEqSpy).not.toHaveBeenCalledWith("status", "visible");
  });

  it("filters to visible-only for non-coordinator (route adds .eq(status, visible))", async () => {
    // Forum: user is NOT coordinator.
    mocks.forumQuery.mockResolvedValue({
      data: { coordinator_user_id: "other-user", tenant_id: TENANT_ID },
      error: null,
    });
    mocks.messagesQuery.mockResolvedValue({
      data: [{ id: "m1", content: "Hi", status: "visible", user_id: "u2", parent_message_id: null, created_at: "2026-01-01T00:00:00Z" }],
      error: null,
    });

    const { GET } = await import("@/app/api/forums/[forumId]/threads/[threadId]/messages/route");
    const res = await GET(
      makeReq(`/api/forums/${FORUM_ID}/threads/${THREAD_ID}/messages`),
      { params: Promise.resolve({ forumId: FORUM_ID, threadId: THREAD_ID }) },
    );

    expect(res.status).toBe(200);
    const body: { messages: unknown[]; is_coordinator: boolean } = await res.json();
    expect(body.is_coordinator).toBe(false);
    expect(body.messages).toHaveLength(1);
    // Security-critical: non-coordinator path MUST apply .eq("status", "visible").
    expect(mocks.messagesEqSpy).toHaveBeenCalledWith("status", "visible");
  });
});
