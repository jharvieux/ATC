// #908 — escalate + persona-switch routes must enforce conversation ownership.
// Before this fix both acted on ANY conversation id in the tenant: a customer
// could escalate another customer's thread or switch its persona. The guard is
// the same owner-or-staff rule as the read path; 404 leaks no existence.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  conv: null as Record<string, unknown> | null,
  callerUsersId: "users-owner" as string | null,
  callerRole: "viewer" as string,
  escalationInserts: 0,
  conversationUpdates: 0,
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => ({
    ctx: { tenant_id: "tenant-1", source: { kind: "http_request", user_id: "auth-1" } },
  })),
}));
vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: vi.fn(() => Response.json({ error: "auth" }, { status: 401 })),
}));
vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: vi.fn(async () => ({ data: null, error: null })),
}));
vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) chain[m] = () => chain;
      chain.update = () => { h.conversationUpdates++; return chain; };
      chain.insert = () => {
        if (table === "escalation_topics") h.escalationInserts++;
        return chain;
      };
      chain.maybeSingle = async () => {
        if (table === "conversations") return { data: h.conv, error: null };
        if (table === "users") {
          return { data: h.callerUsersId ? { id: h.callerUsersId, role: h.callerRole } : null, error: null };
        }
        if (table === "personas") return { data: { id: "persona-1" }, error: null };
        return { data: null, error: null };
      };
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
      return chain;
    },
  }),
}));

import { POST as ESCALATE } from "@/app/api/chat/escalate/route";
import { POST as SWITCH_PERSONA } from "@/app/api/chat/conversations/[id]/persona/route";

const CONV = { id: "c-1", audience: "customer", user_id: "users-owner" };

function escalateReq(): Request {
  return new Request("https://t.example.com/api/chat/escalate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversation_id: "c-1", reason: "want a human" }),
  });
}
function personaArgs(): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request("https://t.example.com/api/chat/conversations/c-1/persona", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ persona_slug: "marcus-cole" }),
    }),
    { params: Promise.resolve({ id: "c-1" }) },
  ];
}

beforeEach(() => {
  h.conv = { ...CONV };
  h.callerUsersId = "users-owner";
  h.callerRole = "viewer";
  h.escalationInserts = 0;
  h.conversationUpdates = 0;
});

describe("POST /api/chat/escalate ownership (#908)", () => {
  it("owner escalates their own thread", async () => {
    const res = await ESCALATE(escalateReq());
    expect(res.status).toBe(200);
    expect(h.escalationInserts).toBe(1);
  });

  it("another viewer gets 404 and nothing is written", async () => {
    h.callerUsersId = "users-other-customer";
    const res = await ESCALATE(escalateReq());
    expect(res.status).toBe(404);
    expect(h.escalationInserts).toBe(0);
  });

  it("unknown conversation id → 404 before any write", async () => {
    h.conv = null;
    const res = await ESCALATE(escalateReq());
    expect(res.status).toBe(404);
    expect(h.escalationInserts).toBe(0);
  });
});

describe("POST /api/chat/conversations/[id]/persona ownership (#908)", () => {
  it("owner switches persona on their own thread", async () => {
    const res = await SWITCH_PERSONA(...personaArgs());
    expect(res.status).toBe(200);
    expect(h.conversationUpdates).toBe(1);
  });

  it("another viewer gets 404 and the conversation is not touched", async () => {
    h.callerUsersId = "users-other-customer";
    const res = await SWITCH_PERSONA(...personaArgs());
    expect(res.status).toBe(404);
    expect(h.conversationUpdates).toBe(0);
  });

  it("staff (agent) may switch persona on a customer thread — and the write fires", async () => {
    h.callerUsersId = "users-an-agent";
    h.callerRole = "agent";
    const res = await SWITCH_PERSONA(...personaArgs());
    expect(res.status).toBe(200);
    expect(h.conversationUpdates).toBe(1);
  });

  it("unknown conversation id → 404 before any write", async () => {
    h.conv = null;
    const res = await SWITCH_PERSONA(...personaArgs());
    expect(res.status).toBe(404);
    expect(h.conversationUpdates).toBe(0);
  });
});
