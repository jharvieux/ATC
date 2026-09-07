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
  data: { id: "log-1", tenant_id: "tenant-1" },
  error: null,
};
const mockSafeAwaitCalls: string[] = [];
let mockApplyResult = [{ outcome: "applied", soft_retry_eligible: false }];
const mockRpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: async (q: Promise<unknown>, label: string) => {
    mockSafeAwaitCalls.push(label);
    const result = await q as { data: unknown; error: unknown };
    if (result.error) throw result.error;
    return result.data;
  },
}));

const mockInngestSend = vi.fn();
vi.mock("@/inngest/client", () => ({
  inngest: { send: (...args: unknown[]) => mockInngestSend(...args) },
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      mockRpcCalls.push({ name, args });
      return Promise.resolve({ data: mockApplyResult, error: null });
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(mockMaybeSingleResult),
        }),
      }),
      table,
    }),
  }),
}));

import { POST } from "@/app/api/webhooks/resend/route";

// ── helpers ────────────────────────────────────────────────────────────────

function makeBody(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type,
    created_at: "2026-09-01T12:00:00.000Z",
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
    data: { id: "log-1", tenant_id: "tenant-1" },
    error: null,
  };
  mockApplyResult = [{ outcome: "applied", soft_retry_eligible: false }];
  mockSafeAwaitCalls.length = 0;
  mockRpcCalls.length = 0;
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
    const body = JSON.stringify({
      type: "email.delivered",
      created_at: "2026-09-01T12:00:00.000Z",
      data: {},
    });
    const res = await POST(makeReq(body));
    expect(res.status).toBe(400);
  });

  it("returns 400 before lookup when a status event has an invalid provider timestamp", async () => {
    const body = JSON.stringify({
      type: "email.delivered",
      created_at: "not-a-timestamp",
      data: { email_id: "resend-abc" },
    });
    const res = await POST(makeReq(body));
    expect(res.status).toBe(400);
    expect(mockSafeAwaitCalls).toHaveLength(0);
    expect(mockRpcCalls).toHaveLength(0);
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
    expect(mockSafeAwaitCalls).toEqual(["apply_resend_status_event"]);
    expect(mockRpcCalls).toEqual([{
      name: "apply_resend_status_event",
      args: {
        p_tenant_id: "tenant-1",
        p_email_log_id: "log-1",
        p_event_id: "msg_1",
        p_event_created_at: "2026-09-01T12:00:00.000Z",
        p_status: "delivered",
        p_bounce_reason: null,
      },
    }]);
  });

  it.each(["Permanent", "hard"])("email.bounced %s → records a hard bounce without retrying", async (bounceType) => {
    const body = JSON.stringify({
      type: "email.bounced",
      created_at: "2026-09-01T12:01:00.000Z",
      data: {
        email_id: "resend-abc",
        bounce: { type: bounceType, message: "invalid mailbox" },
      },
    });
    const res = await POST(makeReq(body));
    expect(res.status).toBe(200);
    expect(mockRpcCalls[0]?.args).toMatchObject({
      p_status: "hard_bounced",
      p_bounce_reason: "invalid mailbox",
      p_event_created_at: "2026-09-01T12:01:00.000Z",
    });
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it("email.bounced Temporary → records a soft bounce and triggers its retry", async () => {
    const body = JSON.stringify({
      type: "email.bounced",
      created_at: "2026-09-01T12:02:00.000Z",
      data: {
        email_id: "resend-abc",
        bounce: { type: "Temporary", message: "mailbox full" },
      },
    });
    mockApplyResult = [{ outcome: "applied", soft_retry_eligible: true }];
    const res = await POST(makeReq(body));
    expect(res.status).toBe(200);
    expect(mockRpcCalls[0]?.args).toMatchObject({
      p_status: "soft_bounced",
      p_bounce_reason: "mailbox full",
      p_event_created_at: "2026-09-01T12:02:00.000Z",
    });
    expect(mockInngestSend).toHaveBeenCalledOnce();
    // #1831: the id is load-bearing — it's what collapses a Svix redelivery of
    // this same bounce to a single retry-chain start (Inngest drops a duplicate
    // event id). A typo or dropped field here silently reopens the concurrent-
    // duplicate race that the completed_attempt marker alone doesn't cover.
    // logId is "log-1" from the default mockMaybeSingleResult (see beforeEach).
    expect(mockInngestSend).toHaveBeenCalledWith({
      id: "soft-retry:log-1:attempt:1",
      name: "email/soft.bounce.retry",
      data: { email_log_id: "log-1", tenant_id: "tenant-1", attempt: 1 },
    });
  });

  it("rejects an unknown bounce type before status mutation or retry", async () => {
    const res = await POST(makeReq(makeBody("email.bounced", {
      bounce: { type: "Indeterminate", message: "unclassified" },
    })));
    expect(res.status).toBe(400);
    expect(mockRpcCalls).toHaveLength(0);
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it("#1611: a soft bounce RPC result for a re-send does NOT start a new retry chain", async () => {
    // A re-send (email_log.retry_of set) that soft-bounces must not spawn a
    // fresh attempt=1 chain — the original send's chain self-drives and reads
    // this row's status. Without the gate the chain would loop forever at +6h,
    // never escalating to +12h/+24h or suppressing.
    mockMaybeSingleResult = {
      data: { id: "log-2", tenant_id: "tenant-1" },
      error: null,
    };
    const body = JSON.stringify({
      type: "email.bounced",
      created_at: "2026-09-01T12:03:00.000Z",
      data: { email_id: "resend-abc", bounce: { type: "soft", message: "mailbox full" } },
    });
    const res = await POST(makeReq(body));
    expect(res.status).toBe(200);
    expect(mockSafeAwaitCalls).toEqual(["apply_resend_status_event"]);
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it("delivery followed by a stale soft bounce cannot start a retry", async () => {
    mockApplyResult = [{ outcome: "stale", soft_retry_eligible: false }];
    const res = await POST(makeReq(makeBody("email.bounced", {
      bounce: { type: "soft", message: "late mailbox full" },
    })));
    expect(res.status).toBe(200);
    expect(mockRpcCalls[0]?.args.p_status).toBe("soft_bounced");
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it("an exact soft-bounce redelivery retries the same deterministic Inngest handoff", async () => {
    mockApplyResult = [{ outcome: "duplicate", soft_retry_eligible: true }];
    const body = makeBody("email.bounced", {
      bounce: { type: "soft", message: "mailbox full" },
    });
    await POST(makeReq(body));
    await POST(makeReq(body));
    expect(mockInngestSend).toHaveBeenCalledTimes(2);
    expect(mockInngestSend.mock.calls[0]).toEqual(mockInngestSend.mock.calls[1]);
    expect(mockInngestSend.mock.calls[0]?.[0].id).toBe("soft-retry:log-1:attempt:1");
  });

  it("email.complained → updates email_log + upserts email_suppressions", async () => {
    const res = await POST(makeReq(makeBody("email.complained")));
    expect(res.status).toBe(200);
    expect(mockRpcCalls[0]?.args.p_status).toBe("complained");
    expect(mockSafeAwaitCalls).toEqual(["apply_resend_status_event"]);
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
