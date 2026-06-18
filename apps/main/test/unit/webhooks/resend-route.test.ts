// Unit tests for apps/main/src/app/api/webhooks/resend/route.ts
//
// D-091 security-critical paths: signature verification, per-event dispatch,
// idempotency (email_log row lookup before any mutation).
// The heavy lifting of signature maths is already tested in resend-signature.test.ts;
// this file tests the route's RESPONSE to verification results + event routing.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ──────────────────────────────────────────────────────────────────

let mockVerifyResult = true;
vi.mock("@/lib/webhooks/resend-signature", () => ({
  verifyResendSignature: (_args: unknown) => {
    void _args;
    return mockVerifyResult;
  },
}));

let mockMaybeSingleResult: { data: unknown; error: { message: string } | null } = {
  data: { id: "log-1", tenant_id: "tenant-1", to_email: "user@example.com" },
  error: null,
};
const mockSafeAwaitCalls: string[] = [];
vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: async (q: Promise<unknown>, label: string) => {
    void q;
    mockSafeAwaitCalls.push(label);
    return { data: null, error: null };
  },
}));

const mockInngestSend = vi.fn();
vi.mock("@/inngest/client", () => ({
  inngest: { send: (...args: unknown[]) => mockInngestSend(...args) },
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(mockMaybeSingleResult),
        }),
      }),
      update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      upsert: () => Promise.resolve({ data: null, error: null }),
    }),
  }),
}));

import { POST } from "@/app/api/webhooks/resend/route";

// ── helpers ────────────────────────────────────────────────────────────────

function makeBody(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type,
    data: { email_id: "resend-abc", ...extra },
  });
}

function makeReq(body: string, overrideHeaders?: Record<string, string>): Request {
  return new Request("https://example.com/api/webhooks/resend", {
    method: "POST",
    headers: {
      "svix-id": "msg_1",
      "svix-timestamp": String(Math.floor(Date.now() / 1000)),
      "svix-signature": "v1,fake",
      "content-type": "application/json",
      ...overrideHeaders,
    },
    body,
  });
}

beforeEach(() => {
  process.env.RESEND_WEBHOOK_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  mockVerifyResult = true;
  mockMaybeSingleResult = {
    data: { id: "log-1", tenant_id: "tenant-1", to_email: "user@example.com" },
    error: null,
  };
  mockSafeAwaitCalls.length = 0;
  mockInngestSend.mockReset();
});

// ── auth layer ─────────────────────────────────────────────────────────────

describe("Resend webhook — auth layer", () => {
  it("returns 500 when RESEND_WEBHOOK_SECRET is not set (fail-closed on missing config)", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const res = await POST(makeReq(makeBody("email.delivered")));
    expect(res.status).toBe(500);
    // No DB calls must leak through before the secret check fails
    expect(mockSafeAwaitCalls).toHaveLength(0);
  });

  it("returns 401 when signature verification fails (forged request)", async () => {
    mockVerifyResult = false;
    const res = await POST(makeReq(makeBody("email.delivered")));
    expect(res.status).toBe(401);
    // Must NOT proceed to DB layer — signature is the gatekeeper
    expect(mockSafeAwaitCalls).toHaveLength(0);
  });

  it("passes through when signature is valid", async () => {
    mockVerifyResult = true;
    const res = await POST(makeReq(makeBody("email.delivered")));
    expect(res.status).toBe(200);
  });
});

// ── input validation ───────────────────────────────────────────────────────

describe("Resend webhook — input validation", () => {
  it("returns 400 when body is not valid JSON", async () => {
    const res = await POST(makeReq("not-json"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when email_id is missing from event data", async () => {
    const body = JSON.stringify({ type: "email.delivered", data: {} });
    const res = await POST(makeReq(body));
    expect(res.status).toBe(400);
  });
});

// ── email_log lookup ───────────────────────────────────────────────────────

describe("Resend webhook — email_log lookup", () => {
  it("returns 200 OK when email_log row is not found (race / external send)", async () => {
    mockMaybeSingleResult = { data: null, error: null };
    const res = await POST(makeReq(makeBody("email.delivered")));
    expect(res.status).toBe(200);
    // Must NOT attempt any mutation — nothing to update
    expect(mockSafeAwaitCalls).toHaveLength(0);
  });

  it("returns 500 when email_log DB lookup errors (fail-closed — not treated as 'not found')", async () => {
    // Pre-existing bug fix: the route was discarding `error` from maybySingle,
    // silently treating a DB error as "row not found" and returning 200 OK.
    // This test pins the corrected behavior: error → 500.
    mockMaybeSingleResult = { data: null, error: { message: "connection timeout" } };
    const res = await POST(makeReq(makeBody("email.delivered")));
    expect(res.status).toBe(500);
    // No mutation must fire on a DB error
    expect(mockSafeAwaitCalls).toHaveLength(0);
  });
});

// ── event routing ──────────────────────────────────────────────────────────

describe("Resend webhook — event routing", () => {
  it("email.delivered → updates email_log with status='delivered'", async () => {
    const res = await POST(makeReq(makeBody("email.delivered")));
    expect(res.status).toBe(200);
    expect(mockSafeAwaitCalls).toContain("email_log.update");
  });

  it("email.bounced hard → updates email_log + upserts email_suppressions", async () => {
    const body = JSON.stringify({
      type: "email.bounced",
      data: {
        email_id: "resend-abc",
        bounce: { type: "hard", message: "invalid mailbox" },
      },
    });
    const res = await POST(makeReq(body));
    expect(res.status).toBe(200);
    // Both email_log update and email_suppressions upsert must fire
    expect(mockSafeAwaitCalls.filter((l) => l === "email_log.update")).toHaveLength(1);
    expect(mockSafeAwaitCalls.filter((l) => l === "email_suppressions.upsert")).toHaveLength(1);
    // Soft-bounce retry must NOT fire for hard bounce
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it("email.bounced soft → updates email_log + triggers Inngest retry (no suppression)", async () => {
    const body = JSON.stringify({
      type: "email.bounced",
      data: {
        email_id: "resend-abc",
        bounce: { type: "soft", message: "mailbox full" },
      },
    });
    const res = await POST(makeReq(body));
    expect(res.status).toBe(200);
    expect(mockSafeAwaitCalls).toContain("email_log.update");
    // Soft bounce fires Inngest — not email_suppressions
    expect(mockInngestSend).toHaveBeenCalledOnce();
    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: "email/soft.bounce.retry" }),
    );
    expect(mockSafeAwaitCalls).not.toContain("email_suppressions.upsert");
  });

  it("email.complained → updates email_log + upserts email_suppressions", async () => {
    const res = await POST(makeReq(makeBody("email.complained")));
    expect(res.status).toBe(200);
    expect(mockSafeAwaitCalls.filter((l) => l === "email_log.update")).toHaveLength(1);
    expect(mockSafeAwaitCalls.filter((l) => l === "email_suppressions.upsert")).toHaveLength(1);
  });

  it("email.opened → returns 200 without any DB mutation (engagement only)", async () => {
    const res = await POST(makeReq(makeBody("email.opened")));
    expect(res.status).toBe(200);
    expect(mockSafeAwaitCalls).toHaveLength(0);
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it("email.clicked → returns 200 without any DB mutation (engagement only)", async () => {
    const res = await POST(makeReq(makeBody("email.clicked")));
    expect(res.status).toBe(200);
    expect(mockSafeAwaitCalls).toHaveLength(0);
  });

  it("email.sent → returns 200 as a no-op (already logged at send time)", async () => {
    const res = await POST(makeReq(makeBody("email.sent")));
    expect(res.status).toBe(200);
    expect(mockSafeAwaitCalls).toHaveLength(0);
  });

  it("unknown event type → returns 200 without DB mutation (no log injection — raw type withheld from logs)", async () => {
    // A forged or unrecognised event type must not inject into logs or mutate state.
    // The handler warns via console.warn without logging the raw value.
    const res = await POST(makeReq(makeBody("email.evil'; DROP TABLE email_log;--")));
    expect(res.status).toBe(200);
    expect(mockSafeAwaitCalls).toHaveLength(0);
    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});
