// #913 — GET /api/chat/conversations must filter by public.users.id, not
// auth.users.id. Before this fix the filter never matched (two distinct id
// spaces), so authenticated customers saw no conversations or all tenant
// conversations depending on RLS. The TA list route (#902) already did
// this correctly; this brings the customer list into line.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  authUserId: "auth-1" as string | null,
  publicUserId: "users-1" as string | null,
  usersErr: null as { message: string } | null,
  conversations: [] as Array<Record<string, unknown>>,
  convsErr: null as { message: string } | null,
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => ({
    ctx: {
      tenant_id: "tenant-1",
      source: { kind: "http_request", user_id: h.authUserId },
    },
  })),
}));
vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: vi.fn(() => Response.json({ error: "auth" }, { status: 401 })),
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
      chain.then = (resolve: (v: unknown) => void) =>
        resolve({ data: h.conversations, error: h.convsErr });
      return chain;
    },
  }),
}));

import { GET } from "@/app/api/chat/conversations/route";

function req() {
  return new Request("https://t.example.com/api/chat/conversations");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.authUserId = "auth-1";
  h.publicUserId = "users-1";
  h.usersErr = null;
  h.conversations = [{ id: "conv-1", title: "Cruise ideas", message_count: 5 }];
  h.convsErr = null;
});

describe("GET /api/chat/conversations (#913)", () => {
  it("returns conversations when auth→public users.id resolution succeeds", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: unknown[] };
    expect(body.conversations).toHaveLength(1);
  });

  it("returns empty list when no users row exists (new user with no conversations yet)", async () => {
    h.publicUserId = null;
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: unknown[] };
    expect(body.conversations).toHaveLength(0);
  });

  it("users DB error → 500 (not a silent empty list)", async () => {
    h.usersErr = { message: "db down" };
    const res = await GET(req());
    expect(res.status).toBe(500);
  });

  it("conversations DB error → 500", async () => {
    h.convsErr = { message: "timeout" };
    const res = await GET(req());
    expect(res.status).toBe(500);
  });

  it("null auth_user_id → empty list (anonymous path)", async () => {
    h.authUserId = null;
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: unknown[] };
    expect(body.conversations).toHaveLength(0);
  });
});
