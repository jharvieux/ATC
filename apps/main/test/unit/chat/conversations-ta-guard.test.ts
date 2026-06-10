// #902/#908 — member-level access guard on GET /api/chat/conversations/[id].
// #902 made TA threads own-only; #908 extends the rule to customer threads:
// owner OR staff (tenant_owner/agent). Customers are viewer-role members, so
// before #908 any signed-up customer could read any other customer's full
// transcript by id. 404 (never 403) so existence isn't leaked.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  conv: null as Record<string, unknown> | null,
  callerUsersId: null as string | null,
  callerRole: "viewer" as string,
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
            data: h.callerUsersId ? { id: h.callerUsersId, role: h.callerRole } : null,
            error: h.usersLookupError,
          };
        }
        return { data: null, error: null };
      };
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
const CUSTOMER_CONV = { ...TA_CONV, audience: "customer" };

beforeEach(() => {
  h.conv = { ...TA_CONV };
  h.callerUsersId = "users-owner";
  h.callerRole = "viewer";
  h.usersLookupError = null;
});

describe("GET /api/chat/conversations/[id] — TA threads (own-only, #902/D-195)", () => {
  it("owner reads their own TA thread", async () => {
    const res = await GET(...req());
    expect(res.status).toBe(200);
  });

  it("another member gets 404 — existence isn't leaked", async () => {
    h.callerUsersId = "users-someone-else";
    const res = await GET(...req());
    expect(res.status).toBe(404);
  });

  it("tenant_owner does NOT get someone else's TA thread (D-195 own-only beats staff)", async () => {
    h.callerUsersId = "users-the-boss";
    h.callerRole = "tenant_owner";
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
});

describe("GET /api/chat/conversations/[id] — customer threads (owner-or-staff, #908)", () => {
  beforeEach(() => { h.conv = { ...CUSTOMER_CONV }; });

  it("owner (viewer customer) reads their own thread", async () => {
    const res = await GET(...req());
    expect(res.status).toBe(200);
  });

  it("ANOTHER viewer (i.e. another customer) gets 404 — the #908 fix", async () => {
    h.callerUsersId = "users-other-customer";
    const res = await GET(...req());
    expect(res.status).toBe(404);
  });

  it("agent reads a customer thread (CRM oversight keeps working)", async () => {
    h.callerUsersId = "users-an-agent";
    h.callerRole = "agent";
    const res = await GET(...req());
    expect(res.status).toBe(200);
  });

  it("tenant_owner reads a customer thread", async () => {
    h.callerUsersId = "users-the-boss";
    h.callerRole = "tenant_owner";
    const res = await GET(...req());
    expect(res.status).toBe(200);
  });

  it("anonymous-owned thread (user_id null): staff yes, viewer no", async () => {
    h.conv = { ...CUSTOMER_CONV, user_id: null };
    h.callerUsersId = "users-some-viewer";
    expect((await GET(...req())).status).toBe(404);
    h.callerUsersId = "users-an-agent";
    h.callerRole = "agent";
    expect((await GET(...req())).status).toBe(200);
  });
});
