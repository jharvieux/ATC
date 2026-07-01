// §19.x — request-level contract tests for the anonymous-invitee forum
// routes: GET /api/groups/invite/[token]/forum and
// GET+POST /api/groups/invite/[token]/forum/threads.
//
// Intent under test:
//   1. An invalid/revoked/expired token is rejected before any forum table
//      is touched (isolation chain: HMAC → invitation_id → group_id).
//   2. A missing forum row 404s.
//   3. Thread creation is blocked for a `not_going` invitee, a locked forum,
//      and a sailed group — before any forum_threads.insert.
//   4. A successful thread create sets created_by_invitation_id, not
//      created_by_user_id.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  parseAndVerifyHmac: vi.fn(),
  invitationLookup: vi.fn(),
  groupLookup: vi.fn(),
  forumLookup: vi.fn(),
  threadsListLookup: vi.fn(),
  threadInsert: vi.fn(),
}));

vi.mock("@/lib/groups/invitation-token", () => ({
  parseAndVerifyHmac: mocks.parseAndVerifyHmac,
  generateToken: (id: string) => `tok-${id}`,
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "invitations") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: mocks.invitationLookup }) }),
          update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
        };
      }
      if (table === "groups") {
        return { select: () => ({ eq: () => ({ maybeSingle: mocks.groupLookup }) }) };
      }
      if (table === "forums") {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: mocks.forumLookup }) }) }),
        };
      }
      if (table === "forum_threads") {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ is: () => ({ order: () => ({ order: mocks.threadsListLookup }) }) }) }),
          }),
          insert: () => ({ select: () => ({ single: mocks.threadInsert }) }),
        };
      }
      throw new Error(`unmocked table: ${table}`);
    },
  }),
}));

const TOKEN = "tok-inv-1.sig";
const PARAMS = { params: Promise.resolve({ token: TOKEN }) };

const INVITATION_BASE = {
  id: "inv-1",
  group_id: "grp-1",
  rsvp_state: "interested",
  visibility_choice: "no_opinion" as const,
  token_revoked_at: null,
  token_revoked_reason: null,
};

const GROUP_BASE = {
  id: "grp-1",
  status: "active",
  sailed_at: null,
  sailing_date: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  visibility_default: "visible" as const,
  tenant_id: "tenant-1",
};

const OPEN_FORUM = { id: "forum-1", is_locked: false };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.parseAndVerifyHmac.mockReturnValue({ invitation_id: "inv-1", ok: true });
  mocks.invitationLookup.mockResolvedValue({ data: INVITATION_BASE, error: null });
  mocks.groupLookup.mockResolvedValue({ data: GROUP_BASE, error: null });
  mocks.forumLookup.mockResolvedValue({ data: OPEN_FORUM, error: null });
  mocks.threadsListLookup.mockResolvedValue({ data: [], error: null });
});

describe("GET /api/groups/invite/[token]/forum", () => {
  it("400s invalid_token before touching the forums table", async () => {
    mocks.parseAndVerifyHmac.mockReturnValue({ invitation_id: "", ok: false });
    const { GET } = await import("@/app/api/groups/invite/[token]/forum/route");

    const res = await GET(new Request(`https://example.com/api/groups/invite/garbage/forum`), { params: Promise.resolve({ token: "garbage" }) });

    expect(res.status).toBe(400);
    expect(mocks.forumLookup).not.toHaveBeenCalled();
  });

  it("404s forum_not_found when the group has no forum row", async () => {
    mocks.forumLookup.mockResolvedValue({ data: null, error: null });
    const { GET } = await import("@/app/api/groups/invite/[token]/forum/route");

    const res = await GET(new Request(`https://example.com/api/groups/invite/${TOKEN}/forum`), PARAMS);

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("forum_not_found");
  });

  it("returns forum_id, is_locked, and the thread list on the happy path", async () => {
    mocks.threadsListLookup.mockResolvedValue({
      data: [{ id: "th-1", title: "Excursions", is_locked: false, is_pinned: true, is_announcement: false, created_at: "2026-06-01T00:00:00Z" }],
      error: null,
    });
    const { GET } = await import("@/app/api/groups/invite/[token]/forum/route");

    const res = await GET(new Request(`https://example.com/api/groups/invite/${TOKEN}/forum`), PARAMS);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ forum_id: "forum-1", is_locked: false });
    expect(body.threads).toHaveLength(1);
  });
});

describe("POST /api/groups/invite/[token]/forum/threads", () => {
  function postReq(body: unknown = { title: "Excursion planning" }) {
    return new Request(`https://example.com/api/groups/invite/${TOKEN}/forum/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("403s a not_going invitee before any insert", async () => {
    mocks.invitationLookup.mockResolvedValue({ data: { ...INVITATION_BASE, rsvp_state: "not_going" }, error: null });
    const { POST } = await import("@/app/api/groups/invite/[token]/forum/threads/route");

    const res = await POST(postReq(), PARAMS);

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("posting_not_permitted");
    expect(mocks.threadInsert).not.toHaveBeenCalled();
  });

  it("403s when the forum is locked", async () => {
    mocks.forumLookup.mockResolvedValue({ data: { id: "forum-1", is_locked: true }, error: null });
    const { POST } = await import("@/app/api/groups/invite/[token]/forum/threads/route");

    const res = await POST(postReq(), PARAMS);

    expect(res.status).toBe(403);
    expect(mocks.threadInsert).not.toHaveBeenCalled();
  });

  it("410s group_sailed (status='sailed') before any insert", async () => {
    mocks.groupLookup.mockResolvedValue({ data: { ...GROUP_BASE, status: "sailed" }, error: null });
    const { POST } = await import("@/app/api/groups/invite/[token]/forum/threads/route");

    const res = await POST(postReq(), PARAMS);

    expect(res.status).toBe(410);
    expect((await res.json()).error).toBe("group_sailed");
    expect(mocks.threadInsert).not.toHaveBeenCalled();
  });

  it("410s group_sailed on sailed_at alone, even if status wasn't updated", async () => {
    mocks.groupLookup.mockResolvedValue({ data: { ...GROUP_BASE, sailed_at: "2025-11-01T00:00:00Z" }, error: null });
    const { POST } = await import("@/app/api/groups/invite/[token]/forum/threads/route");

    const res = await POST(postReq(), PARAMS);

    expect(res.status).toBe(410);
    expect(mocks.threadInsert).not.toHaveBeenCalled();
  });

  it("creates the thread attributed to the invitation, not a user", async () => {
    mocks.threadInsert.mockResolvedValue({
      data: { id: "th-new", forum_id: "forum-1", created_by_invitation_id: "inv-1", created_by_user_id: null, title: "Excursion planning" },
      error: null,
    });
    const { POST } = await import("@/app/api/groups/invite/[token]/forum/threads/route");

    const res = await POST(postReq(), PARAMS);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.created_by_invitation_id).toBe("inv-1");
    expect(body.created_by_user_id).toBeNull();
  });
});
