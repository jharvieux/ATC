// #890 — resend-inbound webhook route tests.
//
// Signature maths is covered by resend-signature.test.ts (recorded-fixture,
// D-091 #12); these tests pin the route's security ORDERING and outcomes:
//   - fail-closed on missing secret / bad signature
//   - replay/dedup: an existing inbound_emails row short-circuits BEFORE any
//     forward (the row means "fully processed" — D-091 #10/#20)
//   - the row is inserted only AFTER a successful/terminal forward, and a
//     transient forward failure returns 500 with NO row so the provider
//     retry reprocesses (double-send prevented by the Idempotency-Key)

import { beforeEach, describe, expect, it, vi } from "vitest";

let mockVerifyResult = true;
vi.mock("@/lib/webhooks/resend-signature", () => ({
  verifyResendSignature: () => mockVerifyResult,
}));

// Shared call-order log across the notification + DB mocks.
const calls: string[] = [];

let mockResolution: unknown = { method: "unresolved" };
vi.mock("@/lib/email/inbound", () => ({
  fetchReceivedEmail: async () => ({ text: "reply body", headers: {} }),
  extractReferencedMessageIds: () => [],
  resolveInboundTenant: async () => mockResolution,
}));

let mockForwardResult: Record<string, unknown> = { status: "sent", email_log_id: "log-7" };
const forwardCalls: Record<string, unknown>[] = [];
vi.mock("@/lib/email/notifications", () => ({
  sendTenantNotification: async (input: Record<string, unknown>) => {
    calls.push("forward");
    forwardCalls.push(input);
    return mockForwardResult;
  },
}));

let mockExistingRow: unknown = null;
let mockTenantRow: unknown = { support_email: "support@acme.com" };
let mockInsertError: { code?: string; message: string } | null = null;
const insertCalls: Record<string, unknown>[] = [];
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "inbound_emails") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: mockExistingRow, error: null }) }),
          }),
          insert: (row: Record<string, unknown>) => {
            calls.push("insert");
            insertCalls.push(row);
            return Promise.resolve({ error: mockInsertError });
          },
        };
      }
      if (table === "tenants") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: mockTenantRow, error: null }) }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import { POST } from "@/app/api/webhooks/resend-inbound/route";

function makeReq(body: string): Request {
  return new Request("https://example.com/api/webhooks/resend-inbound", {
    method: "POST",
    headers: {
      "svix-id": "msg_1",
      "svix-timestamp": String(Math.floor(Date.now() / 1000)),
      "svix-signature": "v1,fake",
      "content-type": "application/json",
    },
    body,
  });
}

function receivedBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "email.received",
    data: {
      email_id: "inb-abc",
      from: "customer@example.com",
      to: ["marcus@ai-travelconcierge.com"],
      subject: "Re: Your deck plans",
      ...extra,
    },
  });
}

beforeEach(() => {
  mockVerifyResult = true;
  mockResolution = { method: "unresolved" };
  mockForwardResult = { status: "sent", email_log_id: "log-7" };
  mockExistingRow = null;
  mockTenantRow = { support_email: "support@acme.com" };
  mockInsertError = null;
  calls.length = 0;
  forwardCalls.length = 0;
  insertCalls.length = 0;
  vi.stubEnv("RESEND_INBOUND_WEBHOOK_SECRET", "whsec_test");
});

describe("resend-inbound webhook", () => {
  it("fails closed (500) when the inbound secret is unset", async () => {
    vi.stubEnv("RESEND_INBOUND_WEBHOOK_SECRET", "");
    const res = await POST(makeReq(receivedBody()));
    expect(res.status).toBe(500);
    expect(calls).toEqual([]);
  });

  it("rejects an invalid signature with 401 before touching the DB", async () => {
    mockVerifyResult = false;
    const res = await POST(makeReq(receivedBody()));
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("acknowledges non-received event types without processing", async () => {
    const res = await POST(makeReq(JSON.stringify({ type: "email.delivered", data: { email_id: "x" } })));
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("400s when email_id or from is missing", async () => {
    const res = await POST(makeReq(JSON.stringify({ type: "email.received", data: { from: "a@b.com" } })));
    expect(res.status).toBe(400);
  });

  it("replay: an existing row short-circuits with 200 — no second forward, no second insert", async () => {
    mockExistingRow = { id: "row-1" };
    mockResolution = { method: "references", tenant_id: "t-1", contact_id: "c-1" };
    const res = await POST(makeReq(receivedBody()));
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("resolved mail forwards to support_email THEN persists (dedup row = fully processed)", async () => {
    mockResolution = { method: "references", tenant_id: "t-1", contact_id: "c-1" };
    const res = await POST(makeReq(receivedBody()));
    expect(res.status).toBe(200);
    expect(calls).toEqual(["forward", "insert"]);

    const fwd = forwardCalls[0] as Record<string, unknown>;
    expect(fwd.to).toBe("support@acme.com");
    expect(fwd.reply_to).toBe("customer@example.com");
    // Deterministic key from the provider id: a webhook retry re-sends with
    // the same key and Resend dedups it (D-091 #23).
    expect(fwd.idempotencyKey).toBe("inbound_forward:inb-abc");
    expect(fwd.category).toBe("transactional");

    const row = insertCalls[0] as Record<string, unknown>;
    expect(row.provider_message_id).toBe("inb-abc");
    expect(row.tenant_id).toBe("t-1");
    expect(row.contact_id).toBe("c-1");
    expect(row.resolution).toBe("references");
    expect(row.forwarded_email_log_id).toBe("log-7");
  });

  it("transient forward failure → 500 and NO row, so the provider retry reprocesses", async () => {
    mockResolution = { method: "sender", tenant_id: "t-1", contact_id: "c-1" };
    mockForwardResult = { status: "failed", reason: "resend_503" };
    const res = await POST(makeReq(receivedBody()));
    expect(res.status).toBe(500);
    expect(calls).toEqual(["forward"]);
    expect(insertCalls).toHaveLength(0);
  });

  it("suppressed forward is terminal: message still persisted (not lost), no forward link", async () => {
    mockResolution = { method: "sender", tenant_id: "t-1", contact_id: "c-1" };
    mockForwardResult = { status: "suppressed", reason: "unsubscribe_all" };
    const res = await POST(makeReq(receivedBody()));
    expect(res.status).toBe(200);
    const row = insertCalls[0] as Record<string, unknown>;
    expect(row.forwarded_email_log_id).toBeNull();
  });

  it("unresolved mail is persisted with tenant_id NULL and never forwarded", async () => {
    mockResolution = { method: "unresolved" };
    const res = await POST(makeReq(receivedBody()));
    expect(res.status).toBe(200);
    expect(calls).toEqual(["insert"]);
    const row = insertCalls[0] as Record<string, unknown>;
    expect(row.tenant_id).toBeNull();
    expect(row.resolution).toBe("unresolved");
  });

  it("tenant without support_email persists the row without forwarding", async () => {
    mockResolution = { method: "references", tenant_id: "t-1", contact_id: null };
    mockTenantRow = { support_email: null };
    const res = await POST(makeReq(receivedBody()));
    expect(res.status).toBe(200);
    expect(calls).toEqual(["insert"]);
  });

  it("treats a 23505 concurrent-duplicate insert as success", async () => {
    mockInsertError = { code: "23505", message: "duplicate key" };
    const res = await POST(makeReq(receivedBody()));
    expect(res.status).toBe(200);
  });

  it("non-unique insert errors fail loud (500) for provider retry", async () => {
    mockInsertError = { code: "XX000", message: "boom" };
    const res = await POST(makeReq(receivedBody()));
    expect(res.status).toBe(500);
  });
});
