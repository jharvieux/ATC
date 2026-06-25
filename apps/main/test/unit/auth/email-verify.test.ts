// §17.2 — no-email recovery: OTP verify + users-row finalize (#62, #74).
//
// Contracts pinned here:
//   1. Brute-force cap: an attacker with their own valid OAuth session must
//      not be able to bind their auth identity to a victim's email by
//      guessing the 6-digit code in a loop. Wrong codes increment attempts;
//      MAX_OTP_ATTEMPTS triggers immediate lockout.
//   2. The pending-email cookie is authoritative for which email row to
//      create — never reads email from the form (the form only carries the
//      code), so a forged form can't redirect the binding to a different
//      address.
//   3. Platform domain mirrors the OAuth callback (#441): a viewer membership is
//      upserted into PLATFORM_DEFAULT_TENANT_ID when set; the agency flow (next
//      cookie = /signup/complete) skips the upsert so /signup/complete can
//      provision a fresh tenant.
//   4. The OTP-verified email is persisted onto the auth user (admin API) so
//      /signup/complete can read it; a persist failure fails loud (/auth/error).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetUser = vi.fn();
const mockUpsert = vi.fn();
const mockFrom = vi.fn(() => ({ upsert: mockUpsert }));
const mockUpdateUserById = vi.fn();

vi.mock("@/lib/auth/ssr-client", () => ({
  createRequestScopedClient: () => ({ auth: { getUser: mockGetUser } }),
}));
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: mockFrom,
    auth: { admin: { updateUserById: mockUpdateUserById } },
  }),
}));

import { POST, _resetIpAttemptsForTests } from "@/app/api/auth/microsoft-email-verify/route";
import { OTP_STORE, MAX_OTP_ATTEMPTS } from "@/lib/auth/otp-store";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  OTP_STORE.clear();
  _resetIpAttemptsForTests();
  delete process.env.PLATFORM_DEFAULT_TENANT_ID;
  mockGetUser.mockResolvedValue({
    data: { user: { id: "auth-user-1" } },
    error: null,
  });
  mockUpsert.mockResolvedValue({ data: null, error: null });
  mockUpdateUserById.mockResolvedValue({ data: { user: { id: "auth-user-1" } }, error: null });
});

afterEach(() => {
  delete process.env.PLATFORM_DEFAULT_TENANT_ID;
});

function postReq(
  code: string,
  opts: { email?: string; tenant?: string; ip?: string; next?: string } = {},
): NextRequest {
  const form = new URLSearchParams();
  form.set("code", code);
  const cookieParts: string[] = [];
  if (opts.email !== undefined) {
    cookieParts.push(`_ms_pending_email=${encodeURIComponent(opts.email)}`);
  }
  if (opts.next !== undefined) {
    cookieParts.push(`_ms_pending_next=${encodeURIComponent(opts.next)}`);
  }
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    "x-resolved-tenant-id": opts.tenant ?? TENANT_ID,
  };
  if (opts.ip !== undefined) headers["x-forwarded-for"] = opts.ip;
  if (cookieParts.length > 0) headers["cookie"] = cookieParts.join("; ");
  return new NextRequest("https://tenant.example.com/api/auth/microsoft-email-verify", {
    method: "POST",
    body: form.toString(),
    headers,
  });
}

describe("POST /api/auth/microsoft-email-verify", () => {
  it("on a valid code: upserts the users row with the cookie-pending email and lands on /", async () => {
    OTP_STORE.set("auth-user-1", { email: "alice@example.com",
      code: "123456",
      expires: Date.now() + 60_000,
      attempts: 0,
    });
    const res = await POST(postReq("123456", { email: "alice@example.com" }));
    expect(mockFrom).toHaveBeenCalledWith("users");
    expect(mockUpsert.mock.calls[0]?.[0]).toEqual({
      auth_user_id: "auth-user-1",
      tenant_id: TENANT_ID,
      email: "alice@example.com",
      status: "active",
    });
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
    // The pending-email cookie should be cleared.
    expect(res.headers.get("set-cookie")).toMatch(/_ms_pending_email=;.*Max-Age=0/);
    // OTP is consumed.
    expect(OTP_STORE.has("auth-user-1")).toBe(false);
  });

  it("on a wrong code: does NOT upsert, increments attempts, lands on /auth/error", async () => {
    OTP_STORE.set("auth-user-1", { email: "alice@example.com",
      code: "123456",
      expires: Date.now() + 60_000,
      attempts: 0,
    });
    const res = await POST(postReq("999999", { email: "alice@example.com" }));
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(new URL(res.headers.get("location")!).pathname).toBe("/auth/error");
    expect(OTP_STORE.get("auth-user-1")?.attempts).toBe(1);
  });

  it("after MAX_OTP_ATTEMPTS wrong codes: locks out and deletes the entry (no further upserts even with the right code)", async () => {
    OTP_STORE.set("auth-user-1", { email: "alice@example.com",
      code: "123456",
      expires: Date.now() + 60_000,
      attempts: MAX_OTP_ATTEMPTS,
    });
    const res = await POST(postReq("123456", { email: "alice@example.com" }));
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(new URL(res.headers.get("location")!).pathname).toBe("/auth/error");
    expect(OTP_STORE.has("auth-user-1")).toBe(false);
  });

  it("on an expired code: deletes the entry, no upsert", async () => {
    OTP_STORE.set("auth-user-1", { email: "alice@example.com",
      code: "123456",
      expires: Date.now() - 1000,
      attempts: 0,
    });
    const res = await POST(postReq("123456", { email: "alice@example.com" }));
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(new URL(res.headers.get("location")!).pathname).toBe("/auth/error");
    expect(OTP_STORE.has("auth-user-1")).toBe(false);
  });

  it("when the pending-email cookie is absent: refuses (cookie is the binding authority, not the form)", async () => {
    OTP_STORE.set("auth-user-1", { email: "alice@example.com",
      code: "123456",
      expires: Date.now() + 60_000,
      attempts: 0,
    });
    const res = await POST(postReq("123456"));
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(new URL(res.headers.get("location")!).pathname).toBe("/auth/error");
  });

  it("when the form code is not 6 digits: refuses without consulting OTP_STORE or session", async () => {
    OTP_STORE.set("auth-user-1", { email: "alice@example.com",
      code: "123456",
      expires: Date.now() + 60_000,
      attempts: 0,
    });
    const res = await POST(postReq("abc", { email: "alice@example.com" }));
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(new URL(res.headers.get("location")!).pathname).toBe("/auth/error");
  });

  it("F-auth-01: refuses when the OTP was minted for a DIFFERENT email than the pending cookie", async () => {
    // The session's OTP was minted for alice; a request carrying a bob cookie
    // must not redeem it (stored.email !== pendingEmail).
    OTP_STORE.set("auth-user-1", { email: "alice@example.com", code: "123456", expires: Date.now() + 60_000, attempts: 0 });
    const res = await POST(postReq("123456", { email: "bob@example.com" }));
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockUpdateUserById).not.toHaveBeenCalled();
    expect(new URL(res.headers.get("location")!).pathname).toBe("/auth/error");
  });

  it("when the cookie session is missing/expired: refuses (auth_user_id must come from a verified session)", async () => {
    OTP_STORE.set("auth-user-1", { email: "alice@example.com",
      code: "123456",
      expires: Date.now() + 60_000,
      attempts: 0,
    });
    mockGetUser.mockResolvedValue({ data: null, error: { message: "no session" } });
    const res = await POST(postReq("123456", { email: "alice@example.com" }));
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(new URL(res.headers.get("location")!).pathname).toBe("/auth/error");
  });

  it("on the platform domain with no default tenant configured: does NOT upsert, still lands on /", async () => {
    OTP_STORE.set("auth-user-1", { email: "alice@example.com",
      code: "123456",
      expires: Date.now() + 60_000,
      attempts: 0,
    });
    const res = await POST(
      postReq("123456", { email: "alice@example.com", tenant: "platform" }),
    );
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });

  it("persists the OTP-verified email onto the auth user so /signup/complete can read it (#441)", async () => {
    OTP_STORE.set("auth-user-1", { email: "alice@example.com", code: "123456", expires: Date.now() + 60_000, attempts: 0 });
    await POST(postReq("123456", { email: "alice@example.com" }));
    expect(mockUpdateUserById).toHaveBeenCalledWith("auth-user-1", {
      email: "alice@example.com",
      email_confirm: true,
    });
  });

  it("fails loud (/auth/error, no upsert) when the auth email update errors — e.g. email already linked", async () => {
    OTP_STORE.set("auth-user-1", { email: "alice@example.com", code: "123456", expires: Date.now() + 60_000, attempts: 0 });
    mockUpdateUserById.mockResolvedValue({ data: null, error: { message: "email exists" } });
    const res = await POST(postReq("123456", { email: "alice@example.com" }));
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(new URL(res.headers.get("location")!).pathname).toBe("/auth/error");
  });

  it("on the agency flow (next cookie = /signup/complete): persists email, SKIPS the upsert, returns to /signup/complete (#441)", async () => {
    process.env.PLATFORM_DEFAULT_TENANT_ID = "f5665f08-3ebb-40e0-ad6b-000000000001";
    OTP_STORE.set("auth-user-1", { email: "alice@example.com", code: "123456", expires: Date.now() + 60_000, attempts: 0 });
    const res = await POST(
      postReq("123456", { email: "alice@example.com", tenant: "platform", next: "/signup/complete" }),
    );
    // Email persisted (so /signup/complete can read it) but NO membership row —
    // the idempotency guard there would otherwise reject as already_provisioned.
    expect(mockUpdateUserById).toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(new URL(res.headers.get("location")!).pathname).toBe("/signup/complete");
    expect(res.headers.get("set-cookie")).toMatch(/_ms_pending_next=;.*Max-Age=0/);
  });

  it("on the platform domain WITH a default tenant (customer flow): upserts a viewer membership into it (#441)", async () => {
    process.env.PLATFORM_DEFAULT_TENANT_ID = "f5665f08-3ebb-40e0-ad6b-000000000001";
    OTP_STORE.set("auth-user-1", { email: "alice@example.com", code: "123456", expires: Date.now() + 60_000, attempts: 0 });
    const res = await POST(
      postReq("123456", { email: "alice@example.com", tenant: "platform" }),
    );
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0]?.[0]).toEqual({
      auth_user_id: "auth-user-1",
      tenant_id: "f5665f08-3ebb-40e0-ad6b-000000000001",
      email: "alice@example.com",
      status: "active",
    });
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });

  it("after 10 attempts from the same IP: the 11th is rejected before consulting OTP_STORE", async () => {
    OTP_STORE.set("auth-user-1", { email: "alice@example.com",
      code: "123456",
      expires: Date.now() + 60_000,
      attempts: 0,
    });
    // Exhaust the 10-attempt window for this IP.
    for (let i = 0; i < 10; i++) {
      await POST(postReq("999999", { email: "alice@example.com", ip: "1.2.3.4" }));
    }
    // 11th attempt: IP bucket is full — route must reject before touching the
    // session or OTP_STORE. Clear the call counts so we observe only the 11th.
    mockGetUser.mockClear();
    mockUpsert.mockClear();
    const res = await POST(postReq("123456", { email: "alice@example.com", ip: "1.2.3.4" }));
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(new URL(res.headers.get("location")!).pathname).toBe("/auth/error");
  });
});
