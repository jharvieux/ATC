// Tier 2 — GitHub webhook handler (BP32 §32.10.7) error-injection coverage.
//
// Tests the three injection lanes:
//   1. DB error injection — bug_submissions update returns { error }.
//      Handler must surface 500 (Next.js default for thrown error)
//      so GitHub retries the delivery.
//   2. Resource-unavailable injection — missing secret + invalid sig.
//      Handler must return 401 (fails closed; no fall-through allowed).
//   3. Concurrent execution — same issues.closed event delivered twice.
//      Handler must idempotently no-op on the second delivery
//      (already_closed branch).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

let mockSecret: string | null = "test-secret";
let mockSubmission: { id: string; tenant_id: string; github_issue_state: string } | null = {
  id: "sub-1",
  tenant_id: "t-1",
  github_issue_state: "open",
};
let mockUpdateError: { message: string } | null = null;
let mockUpdateCallCount = 0;

vi.mock("@/lib/env", () => ({
  env: () => ({ GITHUB_WEBHOOK_SECRET: mockSecret }),
}));

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: async (
    _opts: unknown,
    fn: (db: unknown, recordQuery: (q: unknown) => void) => Promise<unknown>,
  ) => {
    void _opts;
    const db = {
      from(_table: string) {
        void _table;
        return {
          select(_cols: string) {
            void _cols;
            const chain: Record<string, unknown> = {
              eq() { return chain; },
              async maybeSingle() {
                return { data: mockSubmission, error: null };
              },
            };
            return chain;
          },
          update(_payload: unknown) {
            void _payload;
            mockUpdateCallCount += 1;
            return {
              eq() {
                return {
                  then(resolve: (v: { data: null; error: { message: string } | null }) => unknown) {
                    return resolve({ data: null, error: mockUpdateError });
                  },
                };
              },
            };
          },
        };
      },
    };
    return fn(db, () => {});
  },
}));

vi.mock("@/inngest/client", () => ({
  inngest: {
    send: vi.fn(async () => undefined),
  },
}));

import { POST } from "@/app/api/webhooks/github/route";

const REAL_SECRET = "test-secret";

function signedRequest(body: unknown, opts: { signature?: string | null } = {}): Request {
  const raw = JSON.stringify(body);
  const sig = opts.signature === null
    ? null
    : opts.signature ?? ("sha256=" + createHmac("sha256", REAL_SECRET).update(raw).digest("hex"));
  const headers: HeadersInit = sig ? { "x-hub-signature-256": sig } : {};
  return new Request("https://example.com/api/webhooks/github", {
    method: "POST",
    headers,
    body: raw,
  });
}

beforeEach(() => {
  mockSecret = REAL_SECRET;
  mockSubmission = { id: "sub-1", tenant_id: "t-1", github_issue_state: "open" };
  mockUpdateError = null;
  mockUpdateCallCount = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GitHub webhook — resource-unavailable injection (Pattern 2)", () => {
  it("returns 401 when GITHUB_WEBHOOK_SECRET is missing (fails closed)", async () => {
    mockSecret = null;
    const res = await POST(signedRequest({ action: "closed", issue: { number: 42 } }));
    expect(res.status).toBe(401);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("webhook_not_configured");
  });

  it("returns 401 when signature header is missing", async () => {
    const res = await POST(signedRequest({ action: "closed", issue: { number: 42 } }, { signature: null }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when signature value doesn't match HMAC (fails closed on tampered body)", async () => {
    const res = await POST(
      signedRequest({ action: "closed", issue: { number: 42 } }, { signature: "sha256=deadbeef" }),
    );
    expect(res.status).toBe(401);
  });
});

describe("GitHub webhook — DB error injection (Pattern 1)", () => {
  it("propagates 500 when bug_submissions update returns { error } (handler must surface, not swallow)", async () => {
    mockUpdateError = { message: "synthetic db failure" };
    let caught: unknown = null;
    try {
      const res = await POST(signedRequest({ action: "closed", issue: { number: 42 } }));
      // If the route doesn't catch internally, Next.js converts the thrown
      // Error into a 500 at the runtime layer. In direct invocation here
      // the throw propagates — both are equally valid "non-200 surfaced".
      expect(res.status).toBe(500);
    } catch (err) {
      caught = err;
    }
    if (caught) {
      expect((caught as Error).message).toMatch(/synthetic db failure/);
    }
    expect(mockUpdateCallCount).toBe(1);
  });
});

describe("GitHub webhook — concurrency / idempotency (Pattern 6)", () => {
  it("returns 200 with no DB write when issue is already 'closed' (second delivery is a no-op)", async () => {
    mockSubmission = { id: "sub-1", tenant_id: "t-1", github_issue_state: "closed" };
    const res = await POST(signedRequest({ action: "closed", issue: { number: 42 } }));
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; already_closed?: boolean };
    expect(json.ok).toBe(true);
    expect(json.already_closed).toBe(true);
    expect(mockUpdateCallCount).toBe(0);
  });

  it("returns 200 with ignored=true on non-closed events (GitHub doesn't retry)", async () => {
    const res = await POST(signedRequest({ action: "opened", issue: { number: 42 } }));
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; ignored?: boolean };
    expect(json.ignored).toBe(true);
    expect(mockUpdateCallCount).toBe(0);
  });
});
