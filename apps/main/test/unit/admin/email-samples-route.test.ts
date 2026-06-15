// #489 — Tests for GET/POST /api/admin/email-samples.
//
// Coverage:
//   - 401 when no admin auth
//   - 400 when to_email is invalid or missing
//   - 400 when template is unknown
//   - POST success: wraps in withPlatformAdminAudit, calls sendEmail with the
//     PLATFORM_TENANT_SHIM, returns { ok: true, resend_message_id }
//   - POST Resend failure: sendEmail returns status:"failed" → 500
//   - GET preview: Content-Type text/html, body includes "AI Travel Concierge"

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SendEmailInput, EmailSendResult } from "@/lib/email/send";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@/lib/auth/assert-platform-admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-platform-admin")>(
    "@/lib/auth/assert-platform-admin",
  );
  const gate = async (req: Request) => {
    const id = req.headers.get("x-admin-user-id");
    if (!id) throw new actual.PlatformAdminError(401, "missing_bearer", "Missing auth.");
    return { admin_user_id: id, role: "support" as const, via: "session" as const };
  };
  return {
    ...actual,
    assertPlatformAdmin: vi.fn(gate),
    assertPlatformRole: vi.fn(gate),
    assertPlatformAdminArea: vi.fn(gate),
  };
});

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: vi.fn(async (_opts: unknown, fn: (db: unknown, rq: unknown) => Promise<unknown>) => {
    return fn({}, () => {});
  }),
}));

const mockSendEmail = vi.fn<(input: SendEmailInput) => Promise<EmailSendResult>>();
vi.mock("@/lib/email/send", () => ({ sendEmail: mockSendEmail }));

// Stub renderToStaticMarkup so JSX rendering doesn't need a DOM environment.
vi.mock("react-dom/server", () => ({
  renderToStaticMarkup: () => "<html><body>AI Travel Concierge sample email</body></html>",
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(method: "GET" | "POST", headers: Record<string, string>, body?: unknown): Request {
  return new Request("http://test/api/admin/email-samples" + (method === "GET" ? "?template=T90" : ""), {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function adminHeaders(): Record<string, string> {
  return { "x-admin-user-id": "admin-uuid-test" };
}

const VALID_POST_BODY = {
  template: "T90",
  to_email: "test@example.com",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/admin/email-samples", () => {
  beforeEach(() => {
    mockSendEmail.mockResolvedValue({ status: "sent" as const, resend_message_id: "resend-msg-123", email_log_id: "log-id" });
  });

  it("returns 401 without admin auth", async () => {
    const { POST } = await import("@/app/api/admin/email-samples/route");
    const res = await POST(makeRequest("POST", {}, VALID_POST_BODY));
    expect(res.status).toBe(401);
  });

  it("returns 400 when to_email is missing", async () => {
    const { POST } = await import("@/app/api/admin/email-samples/route");
    const res = await POST(makeRequest("POST", adminHeaders(), { template: "T90" }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/to_email/i);
  });

  it("returns 400 when to_email is malformed", async () => {
    const { POST } = await import("@/app/api/admin/email-samples/route");
    const res = await POST(makeRequest("POST", adminHeaders(), { template: "T90", to_email: "not-an-email" }));
    expect(res.status).toBe(400);
  });

  it("rejects an over-long but format-valid to_email before the regex (#554 ReDoS cap)", async () => {
    // 312 chars: this string MATCHES the validation regex, so without the length
    // cap it would pass and reach sendEmail (200). The cap rejects it at 400 and
    // sendEmail is never called — that's the non-vacuous signal (a revert flips it).
    mockSendEmail.mockClear();
    const overLong = `${"a".repeat(300)}@example.com`;
    const { POST } = await import("@/app/api/admin/email-samples/route");
    const res = await POST(makeRequest("POST", adminHeaders(), { template: "T90", to_email: overLong }));
    expect(res.status).toBe(400);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("returns 400 when template is unknown", async () => {
    const { POST } = await import("@/app/api/admin/email-samples/route");
    const res = await POST(makeRequest("POST", adminHeaders(), { template: "TUnknown", to_email: "x@y.com" }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/template/i);
  });

  it("calls sendEmail with PLATFORM_TENANT_SHIM and returns ok + resend_message_id", async () => {
    const { POST } = await import("@/app/api/admin/email-samples/route");
    const res = await POST(makeRequest("POST", adminHeaders(), VALID_POST_BODY));
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; resend_message_id: string };
    expect(json.ok).toBe(true);
    expect(json.resend_message_id).toBe("resend-msg-123");

    expect(mockSendEmail).toHaveBeenCalledOnce();
    const callArgs = mockSendEmail.mock.calls[0]![0] as SendEmailInput;
    // Tenant must be the platform shim (sentinel UUID)
    expect(callArgs.tenant.id).toBe("00000000-0000-0000-0000-000000000000");
    expect(callArgs.tenant.legal_name).toBe("AI Travel Concierge");
    expect(callArgs.category).toBe("admin_sample");
    expect(callArgs.to).toBe("test@example.com");
  });

  it("wraps the send in withPlatformAdminAudit", async () => {
    const { withPlatformAdminAudit } = await import("@/lib/db/platform-admin-client");
    vi.mocked(withPlatformAdminAudit).mockClear();

    const { POST } = await import("@/app/api/admin/email-samples/route");
    await POST(makeRequest("POST", adminHeaders(), VALID_POST_BODY));

    expect(withPlatformAdminAudit).toHaveBeenCalledOnce();
    const opts = vi.mocked(withPlatformAdminAudit).mock.calls[0]![0] as { reason: string };
    expect(opts.reason).toBe("admin_email_sample_send");
  });

  it("returns 429 when rate limit is reached", async () => {
    mockSendEmail.mockResolvedValue({ status: "rate_limited" as const, reason: "admin_sample_daily_limit_reached" });
    const { POST } = await import("@/app/api/admin/email-samples/route");
    const res = await POST(makeRequest("POST", adminHeaders(), VALID_POST_BODY));
    expect(res.status).toBe(429);
    expect((await res.json() as { error: string }).error).toMatch(/rate limit/i);
  });

  it("returns 500 when Resend fails", async () => {
    mockSendEmail.mockResolvedValue({ status: "failed" as const, reason: "resend_503" });
    const { POST } = await import("@/app/api/admin/email-samples/route");
    const res = await POST(makeRequest("POST", adminHeaders(), VALID_POST_BODY));
    expect(res.status).toBe(500);
    expect((await res.json() as { error: string }).error).toContain("resend_503");
  });
});

describe("GET /api/admin/email-samples (preview)", () => {
  it("returns 401 without admin auth", async () => {
    const { GET } = await import("@/app/api/admin/email-samples/route");
    const res = await GET(makeRequest("GET", {}));
    expect(res.status).toBe(401);
  });

  it("returns text/html with AI Travel Concierge branding", async () => {
    const { GET } = await import("@/app/api/admin/email-samples/route");
    const res = await GET(makeRequest("GET", adminHeaders()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("AI Travel Concierge");
  });

  it("uses audit reason admin_email_sample_preview (not send)", async () => {
    const { withPlatformAdminAudit } = await import("@/lib/db/platform-admin-client");
    vi.mocked(withPlatformAdminAudit).mockClear();

    const { GET } = await import("@/app/api/admin/email-samples/route");
    await GET(makeRequest("GET", adminHeaders()));

    expect(withPlatformAdminAudit).toHaveBeenCalledOnce();
    const opts = vi.mocked(withPlatformAdminAudit).mock.calls[0]![0] as { reason: string };
    expect(opts.reason).toBe("admin_email_sample_preview");
  });
});
