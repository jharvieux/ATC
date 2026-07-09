// §19.7 — Forum threads + messages read API (#1063).
//
// Intent under test:
//   1. GET /api/groups/:id/forum returns forum_id + is_locked + is_coordinator.
//   2. GET /api/groups/:id/forum self-heals a missing forum row on first visit (lazy upsert).
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
  forumUpsert: vi.fn(),
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
      upsert: () => ({
        select: () => ({
          single: mocks.forumUpsert,
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
                    // #1588: second .order() is followed by .range() now
                    // (bounded pagination) rather than terminating itself.
                    // #1701 audit r2: a third .order("id") tiebreaker precedes .range().
                    order: () => ({
                      order: () => ({
                        range: (...args: unknown[]) => mocks.threadsQuery(...args),
                      }),
                    }),
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
        // status="visible" filter is applied for non-coordinators; .order()
        // is followed by another .order("id") tiebreaker (#1701 audit r2),
        // then .range() (#1588 — bounded pagination), which is terminal.
        const msgChain: Record<string, unknown> = {};
        msgChain.eq = (col: string, val: unknown) => { mocks.messagesEqSpy(col, val); return msgChain; };
        msgChain.order = () => ({ order: () => ({ range: (...args: unknown[]) => mocks.messagesQuery(...args) }) });
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
      // #1190: coordinator comes from the embedded group (object shape).
      data: { id: FORUM_ID, is_locked: false, groups: { coordinator_user_id: USER_ID } },
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
      // #1190: coordinator comes from the embedded group (array shape).
      data: { id: FORUM_ID, is_locked: false, groups: [{ coordinator_user_id: "other-user" }] },
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

  it("self-heals a missing forum row: upserts on first visit and returns 200", async () => {
    // WHY: a transient DB error at group-create time can leave a group without a
    // forums row. The route lazy-creates it on first access rather than 404ing permanently.
    mocks.forumQuery.mockResolvedValue({ data: null, error: null });
    mocks.forumUpsert.mockResolvedValue({
      data: { id: FORUM_ID, is_locked: false, groups: { coordinator_user_id: "other-user" } },
      error: null,
    });

    const { GET } = await import("@/app/api/groups/[id]/forum/route");
    const res = await GET(makeReq(`/api/groups/${GROUP_ID}/forum`), {
      params: Promise.resolve({ id: GROUP_ID }),
    });

    expect(res.status).toBe(200);
    const body: { forum_id: string; is_locked: boolean; is_coordinator: boolean } = await res.json();
    expect(body.forum_id).toBe(FORUM_ID);
    expect(body.is_coordinator).toBe(false);
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

  // #1588 — an unbounded select silently loses threads past PostgREST's
  // max-rows cap; pin that the route now issues a bounded .range() and
  // echoes total/limit/offset so a busy forum's thread list can't silently
  // truncate without the client knowing there's more.
  it("honors limit/offset query params and echoes total/limit/offset", async () => {
    const thread = { id: THREAD_ID, title: "Packing tips", is_locked: false, is_pinned: false, is_announcement: false, created_at: "2026-01-01T00:00:00Z" };
    mocks.threadsQuery.mockResolvedValue({ data: [thread], error: null, count: 250 });

    const { GET } = await import("@/app/api/forums/[forumId]/threads/route");
    const res = await GET(makeReq(`/api/forums/${FORUM_ID}/threads?limit=10&offset=20`), {
      params: Promise.resolve({ forumId: FORUM_ID }),
    });

    expect(res.status).toBe(200);
    const body: { total: number; limit: number; offset: number } = await res.json();
    expect(mocks.threadsQuery).toHaveBeenCalledWith(20, 29); // offset, offset + limit - 1
    expect(body.total).toBe(250);
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(20);
  });

  // Mirror of quotes/list-route.test.ts: a caller-supplied oversized limit must
  // be clamped to the route's MAX (200), not trusted — otherwise a client could
  // ask for an unbounded page and defeat the whole point of the .range() bound.
  it("clamps an oversized limit to the 200 cap rather than trusting the caller", async () => {
    mocks.threadsQuery.mockResolvedValue({ data: [], error: null, count: 0 });

    const { GET } = await import("@/app/api/forums/[forumId]/threads/route");
    const res = await GET(makeReq(`/api/forums/${FORUM_ID}/threads?limit=100000`), {
      params: Promise.resolve({ forumId: FORUM_ID }),
    });

    expect(res.status).toBe(200);
    const body: { limit: number } = await res.json();
    expect(body.limit).toBe(200);
    expect(mocks.threadsQuery).toHaveBeenCalledWith(0, 199); // clamped: offset 0, offset + 200 - 1
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
      // #1190: coordinator comes from the embedded group (array shape).
      data: { tenant_id: TENANT_ID, groups: [{ coordinator_user_id: USER_ID }] },
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

  it("returns 500 when forum lookup fails (not fail-open as non-coordinator)", async () => {
    mocks.forumQuery.mockResolvedValue({
      data: null,
      error: { message: "db_error" },
    });

    const { GET } = await import("@/app/api/forums/[forumId]/threads/[threadId]/messages/route");
    const res = await GET(
      makeReq(`/api/forums/${FORUM_ID}/threads/${THREAD_ID}/messages`),
      { params: Promise.resolve({ forumId: FORUM_ID, threadId: THREAD_ID }) },
    );

    expect(res.status).toBe(500);
  });

  // #1588 pagination surface — the messages GET pages newest-first then
  // .reverse()s back to ascending. These pin the three behaviours that were
  // previously untested: limit/offset echo, the 500 clamp, and that the
  // reverse actually restores ascending chronological order for the client.
  it("honors limit/offset query params via .range() and echoes total/limit/offset", async () => {
    mocks.forumQuery.mockResolvedValue({
      data: { tenant_id: TENANT_ID, groups: [{ coordinator_user_id: USER_ID }] },
      error: null,
    });
    mocks.messagesQuery.mockResolvedValue({ data: [], error: null, count: 412 });

    const { GET } = await import("@/app/api/forums/[forumId]/threads/[threadId]/messages/route");
    const res = await GET(
      makeReq(`/api/forums/${FORUM_ID}/threads/${THREAD_ID}/messages?limit=25&offset=50`),
      { params: Promise.resolve({ forumId: FORUM_ID, threadId: THREAD_ID }) },
    );

    expect(res.status).toBe(200);
    const body: { total: number; limit: number; offset: number } = await res.json();
    expect(mocks.messagesQuery).toHaveBeenCalledWith(50, 74); // offset, offset + limit - 1
    expect(body.total).toBe(412);
    expect(body.limit).toBe(25);
    expect(body.offset).toBe(50);
  });

  it("clamps an oversized limit to the 500 cap rather than trusting the caller", async () => {
    mocks.forumQuery.mockResolvedValue({
      data: { tenant_id: TENANT_ID, groups: [{ coordinator_user_id: USER_ID }] },
      error: null,
    });
    mocks.messagesQuery.mockResolvedValue({ data: [], error: null, count: 0 });

    const { GET } = await import("@/app/api/forums/[forumId]/threads/[threadId]/messages/route");
    const res = await GET(
      makeReq(`/api/forums/${FORUM_ID}/threads/${THREAD_ID}/messages?limit=100000`),
      { params: Promise.resolve({ forumId: FORUM_ID, threadId: THREAD_ID }) },
    );

    expect(res.status).toBe(200);
    const body: { limit: number } = await res.json();
    expect(body.limit).toBe(500);
    expect(mocks.messagesQuery).toHaveBeenCalledWith(0, 499); // clamped: offset 0, offset + 500 - 1
  });

  it("reverses the newest-first page back to ascending chronological order for the client", async () => {
    mocks.forumQuery.mockResolvedValue({
      data: { tenant_id: TENANT_ID, groups: [{ coordinator_user_id: USER_ID }] },
      error: null,
    });
    // The route reads .order(created_at DESC) so the DB hands back newest-first;
    // the client renders oldest→newest, so the route must .reverse() it.
    mocks.messagesQuery.mockResolvedValue({
      data: [
        { id: "m3", content: "third", status: "visible", user_id: "u1", invitation_id: null, parent_message_id: null, created_at: "2026-01-03T00:00:00Z" },
        { id: "m2", content: "second", status: "visible", user_id: "u1", invitation_id: null, parent_message_id: null, created_at: "2026-01-02T00:00:00Z" },
        { id: "m1", content: "first", status: "visible", user_id: "u1", invitation_id: null, parent_message_id: null, created_at: "2026-01-01T00:00:00Z" },
      ],
      error: null,
      count: 3,
    });

    const { GET } = await import("@/app/api/forums/[forumId]/threads/[threadId]/messages/route");
    const res = await GET(
      makeReq(`/api/forums/${FORUM_ID}/threads/${THREAD_ID}/messages`),
      { params: Promise.resolve({ forumId: FORUM_ID, threadId: THREAD_ID }) },
    );

    expect(res.status).toBe(200);
    const body: { messages: Array<{ id: string; created_at: string }> } = await res.json();
    expect(body.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    const times = body.messages.map((m) => m.created_at);
    expect([...times].sort()).toEqual(times); // strictly ascending
  });

  it("filters to visible-only for non-coordinator (route adds .eq(status, visible))", async () => {
    // Forum: user is NOT coordinator.
    mocks.forumQuery.mockResolvedValue({
      // #1190: coordinator comes from the embedded group (object shape).
      data: { tenant_id: TENANT_ID, groups: { coordinator_user_id: "other-user" } },
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
