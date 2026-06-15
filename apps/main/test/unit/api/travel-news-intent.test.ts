// §TN — Intent tests for three behavioral rules that must not silently regress:
//
//   1. The public ticker only serves articles with relevance_score ≥ 60
//      AND is_hidden = false — a query missing either filter silently leaks
//      low-quality or hidden content to every chat-page visitor.
//
//   2. POST /articles/[id]/rag returns 409 on a second submission (CAS guard).
//      Without this, two concurrent admin clicks queue duplicate RAG jobs.
//
//   3. POST /articles/[id]/hide returns 404 when the article doesn't exist,
//      not a silent 200 no-op.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
  assertPlatformAdmin: vi.fn(),
  withPlatformAdminAudit: vi.fn(),
  createSubmission: vi.fn(),
  safeAwait: vi.fn(),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

vi.mock("@/lib/auth/assert-platform-admin", () => ({
  assertPlatformAdmin: mocks.assertPlatformAdmin,
  assertPlatformRole: mocks.assertPlatformAdmin,
  assertPlatformAdminArea: mocks.assertPlatformAdmin,
  PlatformAdminError: class extends Error {
    toResponse() {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
  },
}));

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: mocks.withPlatformAdminAudit,
}));

vi.mock("@/lib/rag-ingest/create-submission", () => ({
  createSubmission: mocks.createSubmission,
}));

vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: mocks.safeAwait,
  safeAwaitRowCount: vi.fn(),
}));

// ─── Route imports (receive mocked deps via vi.mock above) ───────────────────

import { GET } from "@/app/api/travel-news/route";
import { POST as ragPost } from "@/app/api/admin/travel-news/articles/[id]/rag/route";
import { POST as hidePost } from "@/app/api/admin/travel-news/articles/[id]/hide/route";

// ─── Helpers ─────────────────────────────────────────────────────────────────

// A chainable proxy: any property access returns a function that returns
// another proxy. Lets us pass a fake db into withPlatformAdminAudit without
// enumerating every method chain the route may call.
const makeProxy = (): unknown =>
  new Proxy({}, {
    get(_t, prop) {
      if (prop === "then" || prop === Symbol.toPrimitive) return undefined;
      return () => makeProxy();
    },
  });

function adminReq(path: string): Request {
  return new Request(`https://admin.example.com${path}`, { method: "POST" });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPlatformAdmin.mockResolvedValue({ admin_user_id: "admin-uuid-1" });
  mocks.withPlatformAdminAudit.mockImplementation(
    async (_ctx: unknown, cb: (db: unknown, rq: unknown) => Promise<unknown>) =>
      cb(makeProxy(), vi.fn()),
  );
});

// ─── 1. Ticker filter intent ──────────────────────────────────────────────────

describe("GET /api/travel-news — ticker filter intent", () => {
  it("queries with is_hidden=false so hidden articles never reach the chat ticker", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    mocks.createServiceRoleClient.mockReturnValue({ from: vi.fn().mockReturnValue(chain) });
    mocks.safeAwait.mockResolvedValue([]);

    const res = await GET();

    expect(chain.eq).toHaveBeenCalledWith("is_hidden", false);
    expect(res.status).toBe(200);
  });

  it("queries with relevance_score>=60 so low-quality articles never reach the chat ticker", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    mocks.createServiceRoleClient.mockReturnValue({ from: vi.fn().mockReturnValue(chain) });
    mocks.safeAwait.mockResolvedValue([]);

    await GET();

    expect(chain.gte).toHaveBeenCalledWith("relevance_score", 60);
  });
});

// ─── 2. RAG CAS guard ─────────────────────────────────────────────────────────

describe("POST /api/admin/travel-news/articles/[id]/rag — CAS guard", () => {
  beforeEach(() => {
    vi.stubEnv("PLATFORM_DEFAULT_TENANT_ID", "platform-tenant-1");
  });

  it("returns 409 when the article was already submitted (rag_submitted_at already set)", async () => {
    let call = 0;
    mocks.safeAwait.mockImplementation(() => {
      call++;
      // First call: CAS UPDATE → 0 rows (already claimed)
      if (call === 1) return Promise.resolve([]);
      // Second call: existence check → article exists
      return Promise.resolve([{ id: "art-1" }]);
    });

    const res = await ragPost(adminReq("/api/admin/travel-news/articles/art-1/rag"), {
      params: Promise.resolve({ id: "art-1" }),
    });

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("already_submitted");
    expect(mocks.createSubmission).not.toHaveBeenCalled();
  });

  it("returns 404 when the article does not exist", async () => {
    // Both safeAwait calls return [] (CAS 0 rows + existence 0 rows)
    mocks.safeAwait.mockResolvedValue([]);

    const res = await ragPost(adminReq("/api/admin/travel-news/articles/missing/rag"), {
      params: Promise.resolve({ id: "missing" }),
    });

    expect(res.status).toBe(404);
  });
});

// ─── 3. Hide 404 ──────────────────────────────────────────────────────────────

describe("POST /api/admin/travel-news/articles/[id]/hide — 404 on missing article", () => {
  it("returns 404 when the target article does not exist, not a silent no-op", async () => {
    mocks.safeAwait.mockResolvedValue([]);

    const res = await hidePost(adminReq("/api/admin/travel-news/articles/ghost/hide"), {
      params: Promise.resolve({ id: "ghost" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_found");
  });
});
