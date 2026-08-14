// Gate tests for POST /api/forums/:forumId/threads/:threadId/messages (§19.3–19.4).
//
// Why these tests matter: cross-tenant isolation and the canPost gate (RSVP state,
// mute) must block writes before any forum_messages.insert executes. The 201 anchor
// test at the end proves the green path works so gate-failure diffs are meaningful.

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  safeAwait: vi.fn(),
  verifyEnvAtBoot: vi.fn(),
  inngestSend: vi.fn(),
  writeAuditLog: vi.fn(),
  recordStrike: vi.fn(),
  checkStrikePatterns: vi.fn(),
  forumSingle: vi.fn(),
  threadSingle: vi.fn(),
  groupMaybeSingle: vi.fn(),
  userStateMaybeSingle: vi.fn(),
  userEmailSingle: vi.fn(),
  invitationMaybeSingle: vi.fn(),
  messageInsertSingle: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/db/safe-mutation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/safe-mutation")>(
    "@/lib/db/safe-mutation",
  );
  return { ...actual, safeAwait: mocks.safeAwait };
});

vi.mock("@/lib/env", () => ({ verifyEnvAtBoot: mocks.verifyEnvAtBoot }));
vi.mock("@/inngest/client", () => ({ inngest: { send: mocks.inngestSend } }));
vi.mock("@/lib/audit/write", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/lib/forums/strikes", () => ({
  recordStrike: mocks.recordStrike,
  checkStrikePatterns: mocks.checkStrikePatterns,
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "forums") {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ single: mocks.forumSingle }) }) }),
        };
      }
      if (table === "forum_threads") {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ eq: () => ({ single: mocks.threadSingle }) }) }),
          }),
        };
      }
      if (table === "groups") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: mocks.groupMaybeSingle }) }),
        };
      }
      if (table === "forum_user_state") {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ maybeSingle: mocks.userStateMaybeSingle }) }),
          }),
        };
      }
      if (table === "users") {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ single: mocks.userEmailSingle }) }) }),
        };
      }
      if (table === "invitations") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ is: () => ({ maybeSingle: mocks.invitationMaybeSingle }) }),
            }),
          }),
        };
      }
      if (table === "forum_messages") {
        return {
          insert: () => ({ select: () => ({ single: mocks.messageInsertSingle }) }),
          update: () => ({ eq: () => ({ eq: () => ({}) }) }),
        };
      }
      return {};
    },
  }),
}));

global.fetch = mocks.fetch as unknown as typeof fetch;

import { POST } from "@/app/api/forums/[forumId]/threads/[threadId]/messages/route";

const TENANT_ID = "t-1";
const FORUM_ID = "forum-1";
const THREAD_ID = "thread-1";
const GROUP_ID = "group-1";
const USER_ID = "user-1";
const PARAMS = { params: Promise.resolve({ forumId: FORUM_ID, threadId: THREAD_ID }) };

function postReq(body: unknown = { content: "Hello world!" }): Request {
  return new Request(
    `https://example.com/api/forums/${FORUM_ID}/threads/${THREAD_ID}/messages`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

const OPEN_FORUM = {
  id: FORUM_ID,
  tenant_id: TENANT_ID,
  group_id: GROUP_ID,
  coordinator_user_id: "coord-1",
  is_locked: false,
};
const OPEN_THREAD = { id: THREAD_ID, forum_id: FORUM_ID, tenant_id: TENANT_ID, is_locked: false };
const ACTIVE_GROUP = { sailed_at: null, status: "active" };

beforeAll(() => { process.env.ANTHROPIC_API_KEY = "sk-test-placeholder"; });
afterAll(() => { delete process.env.ANTHROPIC_API_KEY; });

beforeEach(() => {
  vi.clearAllMocks();

  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID },
    user: { id: USER_ID },
  });
  mocks.verifyEnvAtBoot.mockReturnValue({
    FORUM_MODERATION_HAIKU_TIMEOUT_MS: 5000,
    HAIKU_FORUM_MODERATION_MODEL: "claude-haiku-4-5-20251001",
  });

  mocks.forumSingle.mockResolvedValue({ data: OPEN_FORUM, error: null });
  mocks.threadSingle.mockResolvedValue({ data: OPEN_THREAD, error: null });
  mocks.groupMaybeSingle.mockResolvedValue({ data: ACTIVE_GROUP, error: null });
  mocks.userStateMaybeSingle.mockResolvedValue({ data: null, error: null });
  mocks.userEmailSingle.mockResolvedValue({ data: { email: "user@example.com" }, error: null });
  mocks.invitationMaybeSingle.mockResolvedValue({ data: { rsvp_state: "interested" }, error: null });
  mocks.messageInsertSingle.mockResolvedValue({
    data: { id: "msg-1", thread_id: THREAD_ID, tenant_id: TENANT_ID, content: "Hello world!" },
    error: null,
  });
  mocks.safeAwait.mockResolvedValue(undefined);
  mocks.inngestSend.mockResolvedValue(undefined);
  mocks.writeAuditLog.mockResolvedValue(undefined);

  // Haiku returns a low-score "visible" response
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        content: [
          {
            text: JSON.stringify({
              scores: {
                spam: 0.05, abuse: 0.05, pii_leak: 0.0, off_topic: 0.05,
                misinformation: 0.0, solicitation: 0.0, prompt_injection: 0.0,
              },
              credit_card_pattern: false,
              max_score: 0.05,
              reasoning: "benign message",
            }),
          },
        ],
      }),
  });
});

describe("POST /api/forums/:forumId/threads/:threadId/messages — gate checks (§19.3–19.4)", () => {
  // @rls-covered-by apps/main/test/integration/rls.test.ts#forums: userB cannot SELECT tenantA rows
  it("forum not in tenant → 404 before any write (cross-tenant isolation)", async () => {
    // The tenant_id filter on the forum lookup returns no row — simulates a
    // request where forumId exists but belongs to a different tenant.
    mocks.forumSingle.mockResolvedValue({ data: null, error: null });

    const res = await POST(postReq(), PARAMS);

    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe("forum_not_found");
    expect(mocks.messageInsertSingle).not.toHaveBeenCalled();
  });

  // @rls-covered-by apps/main/test/integration/rls.test.ts#forum_threads: userB cannot SELECT tenantA rows
  it("thread not in forum → 404 before any write (cross-forum isolation)", async () => {
    // The forum_id + tenant_id filter on the thread lookup returns no row —
    // simulates a threadId that belongs to a different forum or tenant.
    mocks.threadSingle.mockResolvedValue({ data: null, error: null });

    const res = await POST(postReq(), PARAMS);

    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe("thread_not_found");
    expect(mocks.messageInsertSingle).not.toHaveBeenCalled();
  });

  it("sailed_at set on group → 410 (§19.10 post-sailing read-only)", async () => {
    mocks.groupMaybeSingle.mockResolvedValue({
      data: { sailed_at: "2025-11-01T00:00:00Z", status: "active" },
      error: null,
    });

    const res = await POST(postReq(), PARAMS);

    expect(res.status).toBe(410);
    expect((await res.json() as { error: string }).error).toBe("forum_read_only_post_sailing");
    expect(mocks.messageInsertSingle).not.toHaveBeenCalled();
  });

  it("group status=sailed → 410 even without sailed_at (§19.10)", async () => {
    mocks.groupMaybeSingle.mockResolvedValue({
      data: { sailed_at: null, status: "sailed" },
      error: null,
    });

    const res = await POST(postReq(), PARAMS);

    expect(res.status).toBe(410);
    expect((await res.json() as { error: string }).error).toBe("forum_read_only_post_sailing");
    expect(mocks.messageInsertSingle).not.toHaveBeenCalled();
  });

  it("rsvp_state=not_going → 403 before any write (canPost RSVP gate)", async () => {
    // A declined invitee must never be able to post, even if they still have
    // a valid session — this is the primary RSVP gate enforcement point.
    mocks.invitationMaybeSingle.mockResolvedValue({ data: { rsvp_state: "not_going" }, error: null });

    const res = await POST(postReq(), PARAMS);

    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("posting_not_permitted");
    expect(mocks.messageInsertSingle).not.toHaveBeenCalled();
  });

  it("permanently muted user → 403 before any write (canPost mute gate)", async () => {
    mocks.userStateMaybeSingle.mockResolvedValue({
      data: { is_muted: true, muted_until: null },
      error: null,
    });

    const res = await POST(postReq(), PARAMS);

    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("posting_not_permitted");
    expect(mocks.messageInsertSingle).not.toHaveBeenCalled();
  });

  it("temporarily muted user (future expiry) → 403 before any write", async () => {
    mocks.userStateMaybeSingle.mockResolvedValue({
      data: { is_muted: true, muted_until: new Date(Date.now() + 3_600_000).toISOString() },
      error: null,
    });

    const res = await POST(postReq(), PARAMS);

    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("posting_not_permitted");
    expect(mocks.messageInsertSingle).not.toHaveBeenCalled();
  });

  it("locked forum → 403 for non-coordinator (canPost forum lock gate)", async () => {
    mocks.forumSingle.mockResolvedValue({
      data: { ...OPEN_FORUM, is_locked: true },
      error: null,
    });

    const res = await POST(postReq(), PARAMS);

    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("posting_not_permitted");
    expect(mocks.messageInsertSingle).not.toHaveBeenCalled();
  });

  it("locked thread → 403 for non-coordinator (canPost thread lock gate)", async () => {
    mocks.threadSingle.mockResolvedValue({
      data: { ...OPEN_THREAD, is_locked: true },
      error: null,
    });

    const res = await POST(postReq(), PARAMS);

    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("posting_not_permitted");
    expect(mocks.messageInsertSingle).not.toHaveBeenCalled();
  });

  it("valid user with non-declined invitation → 201 (green path anchors gate diffs)", async () => {
    // All gates pass; message inserted and moderation runs → visible.
    // Proves the 403/404/410 above are caused by gate conditions, not setup bugs.
    const res = await POST(postReq({ content: "Excited for this trip!" }), PARAMS);

    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; status: string };
    expect(body.id).toBe("msg-1");
    expect(body.status).toBe("visible");
    expect(mocks.messageInsertSingle).toHaveBeenCalledOnce();
    expect(mocks.safeAwait).toHaveBeenCalledOnce();
  });

  it("content over 2,000 chars → 400 before any write (matches the Haiku-scored window exactly)", async () => {
    const res = await POST(postReq({ content: "a".repeat(2_001) }), PARAMS);

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("content_too_long");
    expect(mocks.messageInsertSingle).not.toHaveBeenCalled();
  });
});
