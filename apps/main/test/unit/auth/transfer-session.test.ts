// §11.6 — transfer-session POST (commit/discard) + preview GET (#75, #64).
//
// Contracts pinned here:
//   1. The action drives the permission gate ("commit" vs "discard") — D-091
//      "one assertPermission per semantic operation."
//   2. Cross-tenant isolation: the anonymous_sessions row read is scoped to
//      ctx.tenant_id; a session belonging to another tenant returns 404, not
//      a 403 with "wrong tenant" (don't leak existence).
//   3. Cross-user isolation within the same tenant: a session already
//      transferred to a different user fails 403, never silently re-attached
//      to the current caller.
//   4. Discard clears the atc-anon-session cookie ("start fresh" semantics);
//      commit calls softCommitTransfer.
//   5. Preview returns only USER-authored message content as previews, with
//      time_span computed across the whole anon-session window.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  softCommitTransfer: vi.fn(),
  sessionMaybeSingle: vi.fn(),
  conversationsQuery: vi.fn(),
  messagesQuery: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
      "@/lib/auth/assert-permission",
    );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/transfer/anon-to-auth", () => ({
  softCommitTransfer: mocks.softCommitTransfer,
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "anonymous_sessions") {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.maybeSingle = (...args: unknown[]) => mocks.sessionMaybeSingle(...args);
        return chain;
      }
      if (table === "conversations") {
        // preview resolves the session's conversations first, then their
        // messages (messages have no anonymous_session_id column). Terminal
        // is an awaited `.eq()`, so the chain itself is thenable.
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        const settle = () => Promise.resolve(mocks.conversationsQuery());
        chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          settle().then(res, rej);
        chain.catch = (rej: (e: unknown) => unknown) => settle().catch(rej);
        return chain;
      }
      // messages — terminal is `.order()`.
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.in = () => chain;
      chain.eq = () => chain;
      chain.order = (...args: unknown[]) => mocks.messagesQuery(...args);
      return chain;
    },
  }),
}));

import { POST } from "@/app/api/auth/transfer-session/route";
import { GET as PREVIEW_GET } from "@/app/api/auth/transfer-session/preview/route";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const USER_ID = "user-1";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID, source: { kind: "http_request", user_id: USER_ID } },
    user: { id: USER_ID, auth_user_id: "auth-1", tenant_id: TENANT_ID, status: "active", role: "tenant_owner" },
  });
  mocks.softCommitTransfer.mockResolvedValue({
    status: "soft_committed",
    expires_at: "2026-05-30T00:00:00.000Z",
  });
  // Default: the anon session has one conversation, so preview proceeds to
  // the messages query. Individual tests override messagesQuery.
  mocks.conversationsQuery.mockResolvedValue({ data: [{ id: "conv-1" }], error: null });
});

function postReq(body: unknown): NextRequest {
  return new NextRequest("https://tenant.example.com/api/auth/transfer-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/transfer-session", () => {
  it("rejects an invalid body with 400 and never asserts permission", async () => {
    const res = await POST(postReq({ wrong: "shape" }));
    expect(res.status).toBe(400);
    expect(mocks.assertPermission).not.toHaveBeenCalled();
  });

  it("asserts the permission scoped to the body's action (commit)", async () => {
    mocks.sessionMaybeSingle.mockResolvedValue({
      data: { id: SESSION_ID, tenant_id: TENANT_ID, transferred_to_user_id: null, transfer_soft_commit_at: null },
      error: null,
    });
    await POST(postReq({ anonymous_session_id: SESSION_ID, action: "commit" }));
    expect(mocks.assertPermission).toHaveBeenCalledWith(
      expect.anything(),
      { resource: "SessionTransfer", action: "commit" },
    );
  });

  it("asserts the permission scoped to the body's action (discard)", async () => {
    mocks.sessionMaybeSingle.mockResolvedValue({
      data: { id: SESSION_ID, tenant_id: TENANT_ID, transferred_to_user_id: null, transfer_soft_commit_at: null },
      error: null,
    });
    await POST(postReq({ anonymous_session_id: SESSION_ID, action: "discard" }));
    expect(mocks.assertPermission).toHaveBeenCalledWith(
      expect.anything(),
      { resource: "SessionTransfer", action: "discard" },
    );
  });

  it("commit on a clean session calls softCommitTransfer with the resolved ctx and user", async () => {
    mocks.sessionMaybeSingle.mockResolvedValue({
      data: { id: SESSION_ID, tenant_id: TENANT_ID, transferred_to_user_id: null, transfer_soft_commit_at: null },
      error: null,
    });
    const res = await POST(postReq({ anonymous_session_id: SESSION_ID, action: "commit" }));
    expect(mocks.softCommitTransfer).toHaveBeenCalledWith({
      db: expect.anything(),
      anonymous_session_id: SESSION_ID,
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    });
    expect(res.status).toBe(200);
  });

  it("commit is idempotent — a re-run on a session ALREADY soft-committed to the same user skips softCommitTransfer", async () => {
    mocks.sessionMaybeSingle.mockResolvedValue({
      data: {
        id: SESSION_ID,
        tenant_id: TENANT_ID,
        transferred_to_user_id: USER_ID,
        transfer_soft_commit_at: "2026-05-29T00:00:00Z",
      },
      error: null,
    });
    const res = await POST(postReq({ anonymous_session_id: SESSION_ID, action: "commit" }));
    expect(mocks.softCommitTransfer).not.toHaveBeenCalled();
    const body = (await res.json()) as { idempotent?: boolean };
    expect(body.idempotent).toBe(true);
  });

  it("commit on a session ALREADY soft-committed to a DIFFERENT user → 403, never re-attached", async () => {
    mocks.sessionMaybeSingle.mockResolvedValue({
      data: {
        id: SESSION_ID,
        tenant_id: TENANT_ID,
        transferred_to_user_id: "different-user",
        transfer_soft_commit_at: "2026-05-29T00:00:00Z",
      },
      error: null,
    });
    const res = await POST(postReq({ anonymous_session_id: SESSION_ID, action: "commit" }));
    expect(res.status).toBe(403);
    expect(mocks.softCommitTransfer).not.toHaveBeenCalled();
  });

  it("discard on a clean session clears the atc-anon-session cookie and returns 200", async () => {
    mocks.sessionMaybeSingle.mockResolvedValue({
      data: { id: SESSION_ID, tenant_id: TENANT_ID, transferred_to_user_id: null, transfer_soft_commit_at: null },
      error: null,
    });
    const res = await POST(postReq({ anonymous_session_id: SESSION_ID, action: "discard" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/atc-anon-session=;.*Max-Age=0/);
    expect(mocks.softCommitTransfer).not.toHaveBeenCalled();
  });

  it("discard on a session that is mid-soft-commit → 409 (use /undo, not /discard)", async () => {
    mocks.sessionMaybeSingle.mockResolvedValue({
      data: {
        id: SESSION_ID,
        tenant_id: TENANT_ID,
        transferred_to_user_id: USER_ID,
        transfer_soft_commit_at: "2026-05-29T00:00:00Z",
      },
      error: null,
    });
    const res = await POST(postReq({ anonymous_session_id: SESSION_ID, action: "discard" }));
    expect(res.status).toBe(409);
  });

  // @rls-covered-by resources=table:public.anonymous_sessions target=apps/main/test/integration/rls.test.ts#RLS integration unit-scope companion policies anonymous_sessions: userB cannot SELECT tenantA rows
  it("a session belonging to a different tenant → 404 (don't leak cross-tenant existence)", async () => {
    // The route's .eq("tenant_id", ctx.tenant_id) filter is what makes this
    // happen — we model it by having the mock return null.
    mocks.sessionMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await POST(postReq({ anonymous_session_id: SESSION_ID, action: "commit" }));
    expect(res.status).toBe(404);
  });
});

function getReq(query: string): Request {
  return new Request(
    `https://tenant.example.com/api/auth/transfer-session/preview${query}`,
  );
}

describe("GET /api/auth/transfer-session/preview", () => {
  it("rejects a malformed session uuid with 400", async () => {
    const res = await PREVIEW_GET(getReq("?session=not-a-uuid"));
    expect(res.status).toBe(400);
  });

  // @rls-covered-by resources=table:public.anonymous_sessions target=apps/main/test/integration/rls.test.ts#RLS integration unit-scope companion policies anonymous_sessions: userB cannot SELECT tenantA rows
  it("returns 404 when the session belongs to another tenant (same shape as missing)", async () => {
    mocks.sessionMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await PREVIEW_GET(getReq(`?session=${SESSION_ID}`));
    expect(res.status).toBe(404);
  });

  it("returns the consent-page payload shape with user-authored previews and full-window time_span", async () => {
    mocks.sessionMaybeSingle.mockResolvedValue({
      data: { id: SESSION_ID, tenant_id: TENANT_ID },
      error: null,
    });
    mocks.messagesQuery.mockResolvedValue({
      data: [
        { content: "First user message", role: "user", created_at: "2026-05-28T10:00:00Z" },
        { content: "Second user message", role: "user", created_at: "2026-05-28T10:05:00Z" },
        { content: "Third user message", role: "user", created_at: "2026-05-28T10:10:00Z" },
        { content: "Fourth user message", role: "user", created_at: "2026-05-28T10:15:00Z" },
      ],
      error: null,
    });
    const res = await PREVIEW_GET(getReq(`?session=${SESSION_ID}`));
    const body = (await res.json()) as {
      anonymous_session_id: string;
      message_count: number;
      time_span: { from: string; to: string };
      message_previews: { preview: string; created_at: string }[];
    };
    expect(body.anonymous_session_id).toBe(SESSION_ID);
    expect(body.message_count).toBe(4);
    expect(body.time_span).toEqual({
      from: "2026-05-28T10:00:00Z",
      to: "2026-05-28T10:15:00Z",
    });
    expect(body.message_previews).toHaveLength(3);
    expect(body.message_previews[0]?.preview).toBe("First user message");
  });

  it("truncates long message previews so the consent page doesn't render an essay", async () => {
    mocks.sessionMaybeSingle.mockResolvedValue({
      data: { id: SESSION_ID, tenant_id: TENANT_ID },
      error: null,
    });
    const longContent = "x".repeat(500);
    mocks.messagesQuery.mockResolvedValue({
      data: [{ content: longContent, role: "user", created_at: "2026-05-28T10:00:00Z" }],
      error: null,
    });
    const res = await PREVIEW_GET(getReq(`?session=${SESSION_ID}`));
    const body = (await res.json()) as {
      message_previews: { preview: string }[];
    };
    expect(body.message_previews[0]?.preview.length).toBeLessThan(longContent.length);
    expect(body.message_previews[0]?.preview).toMatch(/…$/);
  });

  it("returns null time_span and empty previews when the session has no user messages yet", async () => {
    mocks.sessionMaybeSingle.mockResolvedValue({
      data: { id: SESSION_ID, tenant_id: TENANT_ID },
      error: null,
    });
    mocks.messagesQuery.mockResolvedValue({ data: [], error: null });
    const res = await PREVIEW_GET(getReq(`?session=${SESSION_ID}`));
    const body = (await res.json()) as {
      message_count: number;
      time_span: unknown;
      message_previews: unknown[];
    };
    expect(body.message_count).toBe(0);
    expect(body.time_span).toBeNull();
    expect(body.message_previews).toEqual([]);
  });

  it("derives messages via conversations — a session with no conversations skips the messages query entirely", async () => {
    // Regression guard for the dead `messages.anonymous_session_id` filter:
    // messages are reached through conversations, so zero conversations means
    // zero messages without ever querying the messages table.
    mocks.sessionMaybeSingle.mockResolvedValue({
      data: { id: SESSION_ID, tenant_id: TENANT_ID },
      error: null,
    });
    mocks.conversationsQuery.mockResolvedValue({ data: [], error: null });
    const res = await PREVIEW_GET(getReq(`?session=${SESSION_ID}`));
    const body = (await res.json()) as { message_count: number; message_previews: unknown[] };
    expect(res.status).toBe(200);
    expect(body.message_count).toBe(0);
    expect(body.message_previews).toEqual([]);
    expect(mocks.messagesQuery).not.toHaveBeenCalled();
  });
});
