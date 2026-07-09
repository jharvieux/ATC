// #1756 — the draft composer's "Draft reply" deep link used to pass the
// full inbound email body via a ?inquiry= URL param, which can exceed
// browser/proxy URL length limits and silently truncate the pre-fill.
// Intent: the composer now fetches the body by (contactId, messageId)
// instead, and this route must scope the message to the contact's own
// conversations — a caller can't read another contact's message by
// guessing an id.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  conversations: [] as Record<string, unknown>[],
  message: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => ({ ctx: { tenant_id: "t-1", source: { kind: "http_request", user_id: "u-1" } } })),
}));
vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: vi.fn(() => Response.json({ error: "auth" }, { status: 401 })),
}));
vi.mock("@/lib/api/db-error-response", () => ({
  dbErrorResponse: vi.fn(() => Response.json({ error: "db" }, { status: 500 })),
}));
vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "limit"]) chain[m] = () => chain;
      chain.maybeSingle = async () => ({
        data: table === "messages" ? h.message : null,
        error: null,
      });
      chain.then = (resolve: (v: unknown) => void) =>
        resolve({ data: table === "conversations" ? h.conversations : [], error: null });
      return chain;
    },
  }),
}));

import { GET } from "@/app/api/crm/contacts/[id]/messages/[messageId]/route";

function req() {
  return new Request("https://t.example.com/api/crm/contacts/c-1/messages/m-1");
}
function params() {
  return { params: Promise.resolve({ id: "c-1", messageId: "m-1" }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.conversations = [{ id: "conv-1" }];
  h.message = { content: "Looking forward to the cruise!", created_at: "2026-07-02T00:00:00Z" };
});

describe("GET /api/crm/contacts/[id]/messages/[messageId] (#1756)", () => {
  it("returns the message body when it belongs to the contact's conversation", async () => {
    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content?: string };
    expect(body.content).toBe("Looking forward to the cruise!");
  });

  it("404s when the contact has no conversations", async () => {
    h.conversations = [];
    const res = await GET(req(), params());
    expect(res.status).toBe(404);
  });

  it("404s when the message id doesn't resolve (wrong contact or bad id)", async () => {
    h.message = null;
    const res = await GET(req(), params());
    expect(res.status).toBe(404);
  });
});
