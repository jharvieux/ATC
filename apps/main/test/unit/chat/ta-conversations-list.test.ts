// #902 PR B — GET /api/chat/ta-conversations own-only list.
// The property that matters: a member only sees their own TA threads —
// the auth_user_id → public.users.id resolution is what makes the
// user_id filter correct (the sibling customer list route has this bug, #913).

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  authUserId: "auth-1" as string | null,
  publicUserId: "users-1" as string | null,
  usersErr: null as { message: string } | null,
  conversations: [] as Array<Record<string, unknown>>,
  convsErr: null as { message: string } | null,
  assertPermErr: null as string | null,
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => {
    if (h.assertPermErr) throw new Error(h.assertPermErr);
    return {
      ctx: {
        tenant_id: "tenant-1",
        source: { kind: "http_request", user_id: h.authUserId },
      },
    };
  }),
}));
vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: vi.fn(() => Response.json({ error: "auth" }, { status: 403 })),
}));
vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) chain[m] = () => chain;
      chain.maybeSingle = async () => {
        if (table === "users") {
          return { data: h.publicUserId ? { id: h.publicUserId } : null, error: h.usersErr };
        }
        return { data: null, error: null };
      };
      // conversations list returns via promise resolution
      chain.then = (resolve: (v: unknown) => void) =>
        resolve({ data: h.conversations, error: h.convsErr });
      return chain;
    },
  }),
}));

import { GET } from "@/app/api/chat/ta-conversations/route";

function req(): Request {
  return new Request("https://t.example.com/api/chat/ta-conversations");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.authUserId = "auth-1";
  h.publicUserId = "users-1";
  h.usersErr = null;
  h.conversations = [{ id: "conv-1", title: "Alaska trip", message_count: 3 }];
  h.convsErr = null;
  h.assertPermErr = null;
});

describe("GET /api/chat/ta-conversations (#902)", () => {
  it("returns own conversations when user resolves", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: unknown[] };
    expect(body.conversations).toHaveLength(1);
  });

  it("missing assertPermission (403) → respondToAuthError, not a list", async () => {
    h.assertPermErr = "forbidden";
    const res = await GET(req());
    expect(res.status).toBe(403);
  });

  it("null auth_user_id on ctx → empty list (graceful, not a 500)", async () => {
    h.authUserId = null;
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: unknown[] };
    expect(body.conversations).toHaveLength(0);
  });

  it("users row not found → empty list (member has no public.users row yet)", async () => {
    h.publicUserId = null;
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: unknown[] };
    expect(body.conversations).toHaveLength(0);
  });

  it("users lookup DB error → 500 (not a silent empty list)", async () => {
    h.usersErr = { message: "db down" };
    const res = await GET(req());
    expect(res.status).toBe(500);
  });

  it("conversations DB error → 500", async () => {
    h.convsErr = { message: "db timeout" };
    const res = await GET(req());
    expect(res.status).toBe(500);
  });
});
