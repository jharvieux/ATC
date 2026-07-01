// §19.x — request-level contract tests for the anonymous-invitee message
// routes: GET+POST /api/groups/invite/[token]/forum/threads/[threadId]/messages.
//
// Intent under test:
//   1. Token/forum/thread resolution gates run before any message write.
//   2. A `not_going` invitee, a locked forum/thread, or a sailed group all
//      block posting before forum_messages.insert.
//   3. A successful post runs the SAME moderation pipeline as the
//      staff-facing route (insertAndModerateForumMessage) and sets
//      invitation_id, not user_id, with status starting 'pending' → then
//      resolved by the (mocked) Haiku moderation call.

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const mocks = vi.hoisted(() => ({
  parseAndVerifyHmac: vi.fn(),
  invitationLookup: vi.fn(),
  groupLookup: vi.fn(),
  forumLookup: vi.fn(),
  threadLookup: vi.fn(),
  messagesListLookup: vi.fn(),
  messageInsertSingle: vi.fn(),
  parentMaybeSingle: vi.fn(),
  updateEq: vi.fn(),
  verifyEnvAtBoot: vi.fn(),
  inngestSend: vi.fn(),
  writeAuditLog: vi.fn(),
  recordStrike: vi.fn(),
  checkStrikePatterns: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/groups/invitation-token", () => ({
  parseAndVerifyHmac: mocks.parseAndVerifyHmac,
  generateToken: (id: string) => `tok-${id}`,
}));

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
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: mocks.forumLookup }) }) }) };
      }
      if (table === "forum_threads") {
        return { select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ is: () => ({ maybeSingle: mocks.threadLookup }) }) }) }) }) };
      }
      if (table === "forum_messages") {
        return {
          select: (cols: string) => {
            if (cols === "id") {
              // parent_message_id scope check inside insertAndModerateForumMessage
              return { eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: mocks.parentMaybeSingle }) }) }) };
            }
            return {
              eq: () => ({ eq: () => ({ eq: () => ({ or: () => ({ order: mocks.messagesListLookup }) }) }) }),
            };
          },
          insert: () => ({ select: () => ({ single: mocks.messageInsertSingle }) }),
          update: () => ({ eq: () => ({ eq: () => mocks.updateEq() }) }),
        };
      }
      throw new Error(`unmocked table: ${table}`);
    },
  }),
}));

global.fetch = mocks.fetch as unknown as typeof fetch;

const TOKEN = "tok-inv-1.sig";
const THREAD_ID = "th-1";
const PARAMS = { params: Promise.resolve({ token: TOKEN, threadId: THREAD_ID }) };

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
const OPEN_THREAD = { id: THREAD_ID, is_locked: false };

function postReq(body: unknown = { content: "Excited for this trip!" }) {
  return new Request(`https://example.com/api/groups/invite/${TOKEN}/forum/threads/${THREAD_ID}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(() => { process.env.ANTHROPIC_API_KEY = "sk-test-placeholder"; });
afterAll(() => { delete process.env.ANTHROPIC_API_KEY; });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.parseAndVerifyHmac.mockReturnValue({ invitation_id: "inv-1", ok: true });
  mocks.invitationLookup.mockResolvedValue({ data: INVITATION_BASE, error: null });
  mocks.groupLookup.mockResolvedValue({ data: GROUP_BASE, error: null });
  mocks.forumLookup.mockResolvedValue({ data: OPEN_FORUM, error: null });
  mocks.threadLookup.mockResolvedValue({ data: OPEN_THREAD, error: null });
  mocks.messagesListLookup.mockResolvedValue({ data: [], error: null });
  mocks.parentMaybeSingle.mockResolvedValue({ data: null, error: null });
  mocks.updateEq.mockResolvedValue({ data: null, error: null });
  mocks.verifyEnvAtBoot.mockReturnValue({
    FORUM_MODERATION_HAIKU_TIMEOUT_MS: 5000,
    HAIKU_FORUM_MODERATION_MODEL: "claude-haiku-4-5-20251001",
  });
  mocks.messageInsertSingle.mockResolvedValue({
    data: { id: "msg-1", thread_id: THREAD_ID, tenant_id: "tenant-1", invitation_id: "inv-1", user_id: null, content: "Excited for this trip!" },
    error: null,
  });
  mocks.inngestSend.mockResolvedValue(undefined);
  mocks.writeAuditLog.mockResolvedValue(undefined);
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      content: [{
        text: JSON.stringify({
          scores: { spam: 0.05, abuse: 0.05, pii_leak: 0.0, off_topic: 0.05, misinformation: 0.0, solicitation: 0.0, prompt_injection: 0.0 },
          credit_card_pattern: false,
          max_score: 0.05,
          reasoning: "benign message",
        }),
      }],
    }),
  });
});

describe("GET /api/groups/invite/[token]/forum/threads/[threadId]/messages", () => {
  it("400s invalid_token before touching forum tables", async () => {
    mocks.parseAndVerifyHmac.mockReturnValue({ invitation_id: "", ok: false });
    const { GET } = await import("@/app/api/groups/invite/[token]/forum/threads/[threadId]/messages/route");

    const res = await GET(new Request("https://example.com/x"), PARAMS);

    expect(res.status).toBe(400);
    expect(mocks.forumLookup).not.toHaveBeenCalled();
  });

  it("404s thread_not_found when the thread isn't in this forum", async () => {
    mocks.threadLookup.mockResolvedValue({ data: null, error: null });
    const { GET } = await import("@/app/api/groups/invite/[token]/forum/threads/[threadId]/messages/route");

    const res = await GET(new Request("https://example.com/x"), PARAMS);

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("thread_not_found");
  });
});

describe("POST /api/groups/invite/[token]/forum/threads/[threadId]/messages", () => {
  it("403s a not_going invitee before any insert", async () => {
    mocks.invitationLookup.mockResolvedValue({ data: { ...INVITATION_BASE, rsvp_state: "not_going" }, error: null });
    const { POST } = await import("@/app/api/groups/invite/[token]/forum/threads/[threadId]/messages/route");

    const res = await POST(postReq(), PARAMS);

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("posting_not_permitted");
    expect(mocks.messageInsertSingle).not.toHaveBeenCalled();
  });

  it("403s when the thread is locked", async () => {
    mocks.threadLookup.mockResolvedValue({ data: { id: THREAD_ID, is_locked: true }, error: null });
    const { POST } = await import("@/app/api/groups/invite/[token]/forum/threads/[threadId]/messages/route");

    const res = await POST(postReq(), PARAMS);

    expect(res.status).toBe(403);
    expect(mocks.messageInsertSingle).not.toHaveBeenCalled();
  });

  it("410s forum_read_only_post_sailing once the group has sailed", async () => {
    mocks.groupLookup.mockResolvedValue({ data: { ...GROUP_BASE, status: "sailed" }, error: null });
    const { POST } = await import("@/app/api/groups/invite/[token]/forum/threads/[threadId]/messages/route");

    const res = await POST(postReq(), PARAMS);

    expect(res.status).toBe(410);
    expect((await res.json()).error).toBe("forum_read_only_post_sailing");
    expect(mocks.messageInsertSingle).not.toHaveBeenCalled();
  });

  it("posts with invitation_id (not user_id) and status starting pending, resolved visible by moderation", async () => {
    const { POST } = await import("@/app/api/groups/invite/[token]/forum/threads/[threadId]/messages/route");

    const res = await POST(postReq(), PARAMS);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.invitation_id).toBe("inv-1");
    expect(body.user_id).toBeNull();
    expect(body.status).toBe("visible"); // Haiku mock returns a low score
    expect(mocks.messageInsertSingle).toHaveBeenCalledOnce();
    expect(mocks.recordStrike).not.toHaveBeenCalled(); // only hidden messages strike, and guest authors don't strike-track at all
  });

  it("skips strike-tracking for a guest-authored hidden message (no user_id to key strikes on)", async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{
          text: JSON.stringify({
            scores: { spam: 0.9, abuse: 0.9, pii_leak: 0.0, off_topic: 0.0, misinformation: 0.0, solicitation: 0.0, prompt_injection: 0.0 },
            credit_card_pattern: false,
            max_score: 0.9,
            reasoning: "spam",
          }),
        }],
      }),
    });
    const { POST } = await import("@/app/api/groups/invite/[token]/forum/threads/[threadId]/messages/route");

    const res = await POST(postReq(), PARAMS);
    const body = await res.json();

    expect(body.status).toBe("hidden");
    expect(mocks.recordStrike).not.toHaveBeenCalled();
  });
});
