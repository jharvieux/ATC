// #902 / D-195 — own-only visibility for TA threads. conversations RLS is
// tenant-scoped only (see #908), so this app-layer guard is what stands
// between a viewer-role customer and a staff thread full of commission talk.
// 404 (never 403) so existence isn't leaked.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  conv: null as Record<string, unknown> | null,
  callerUsersId: null as string | null,
  usersLookupError: null as { message: string } | null,
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => ({
    ctx: { tenant_id: "tenant-1", source: { kind: "http_request", user_id: "auth-1" } },
  })),
}));
vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: vi.fn(() => Response.json({ error: "auth" }, { status: 401 })),
}));
vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit", "update"]) chain[m] = () => chain;
      chain.maybeSingle = async () => {
        if (table === "conversations") return { data: h.conv, error: null };
        if (table === "users") {
          return {
            data: h.callerUsersId ? { id: h.callerUsersId } : null,
            error: h.usersLookupError,
          };
        }
        return { data: null, error: null };
      };
      // messages list after a passing guard
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
      return chain;
    },
  }),
}));

import { GET } from "@/app/api/chat/conversations/[id]/route";

function req(): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request("https://t.example.com/api/chat/conversations/c-1"),
    { params: Promise.resolve({ id: "c-1" }) },
  ];
}

const TA_CONV = {
  id: "c-1", title: null, status: "active", active_persona_id: null,
  last_message_at: null, message_count: 2,
  audience: "tenant_member", user_id: "users-owner",
};

beforeEach(() => {
  h.conv = { ...TA_CONV };
  h.callerUsersId = "users-owner";
  h.usersLookupError = null;
});

describe("GET /api/chat/conversations/[id] — TA-thread own-only guard (#902)", () => {
  it("owner reads their own TA thread", async () => {
    const res = await GET(...req());
    expect(res.status).toBe(200);
  });

  it("another member (e.g. a viewer customer) gets 404 — not 403, existence isn't leaked", async () => {
    h.callerUsersId = "users-someone-else";
    const res = await GET(...req());
    expect(res.status).toBe(404);
  });

  it("unresolvable caller users row → 404 (fail closed)", async () => {
    h.callerUsersId = null;
    const res = await GET(...req());
    expect(res.status).toBe(404);
  });

  it("users lookup error → 404 (fail closed, no open-on-error)", async () => {
    h.usersLookupError = { message: "db down" };
    const res = await GET(...req());
    expect(res.status).toBe(404);
  });

  it("customer-audience threads are untouched by the guard (pre-existing behavior, #908 tracks the wider gap)", async () => {
    h.conv = { ...TA_CONV, audience: "customer", user_id: "users-someone-else" };
    h.callerUsersId = "users-owner";
    const res = await GET(...req());
    expect(res.status).toBe(200);
  });
});
