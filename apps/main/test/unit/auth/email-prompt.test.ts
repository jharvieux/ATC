// §17.2 / F-auth-01 (#1379) — no-email recovery: OTP dispatch.
//
// Contracts pinned here:
//   1. The route REQUIRES an authenticated session (post-OAuth-no-email bounce);
//      no session → 401, no OTP minted. The OTP is keyed by auth_user_id.
//   2. If the OTP can't be MAILED (Resend missing/down) the route fails loud and
//      purges the OTP_STORE entry (no guessable OTP left behind) — D-091 #3.
//   3. Per-IP + per-email regeneration caps bound email-bombing / re-mint abuse.
//   4. The brute-force attempts budget is CARRIED across re-mints (requesting a
//      new code can't reset an attacker's guess counter).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockGetUser = vi.fn();
vi.mock("@/lib/auth/ssr-client", () => ({
  createRequestScopedClient: () => ({ auth: { getUser: mockGetUser } }),
}));

import { POST, _resetRegenForTests } from "@/app/api/auth/microsoft-email-prompt/route";
import { OTP_STORE } from "@/lib/auth/otp-store";

const ORIG_ENV = { ...process.env };
const AUTH_USER_ID = "auth-user-1";
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  OTP_STORE.clear();
  _resetRegenForTests();
  fetchSpy = vi.spyOn(globalThis, "fetch");
  mockGetUser.mockResolvedValue({ data: { user: { id: AUTH_USER_ID } }, error: null });
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v !== undefined) process.env[k] = v;
  }
  fetchSpy.mockRestore();
});

function postReq(email: string | null, ip = "9.9.9.9"): Request {
  const form = new URLSearchParams();
  if (email !== null) form.set("email", email);
  return new Request("https://tenant.example.com/api/auth/microsoft-email-prompt", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
    body: form.toString(),
  });
}

describe("POST /api/auth/microsoft-email-prompt", () => {
  it("F-auth-01: requires a session — no session → 401, no OTP minted, no email sent", async () => {
    process.env.RESEND_API_KEY = "re_test";
    mockGetUser.mockResolvedValue({ data: null, error: { message: "no session" } });
    const res = await POST(postReq("alice@example.com"));
    expect(res.status).toBe(401);
    expect(OTP_STORE.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a missing/invalid email with 400 and never writes an OTP", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const res = await POST(postReq("not-an-email"));
    expect(res.status).toBe(400);
    expect(OTP_STORE.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects email > 254 chars with 400 — length cap guards against polynomial regex backtracking (S5852)", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const longEmail = `${"a".repeat(250)}@x.com`;
    const res = await POST(postReq(longEmail));
    expect(res.status).toBe(400);
    expect(OTP_STORE.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("when RESEND_API_KEY is unset: fails loud (503) — does NOT stash a guessable OTP", async () => {
    delete process.env.RESEND_API_KEY;
    const res = await POST(postReq("alice@example.com"));
    expect(res.status).toBe(503);
    expect(OTP_STORE.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("when Resend returns non-OK: purges the OTP entry and surfaces 502", async () => {
    process.env.RESEND_API_KEY = "re_test";
    fetchSpy.mockResolvedValue(new Response("rate limited", { status: 429 }));
    const res = await POST(postReq("alice@example.com"));
    expect(res.status).toBe(502);
    expect(OTP_STORE.has(AUTH_USER_ID)).toBe(false);
  });

  it("when fetch itself throws (network down): purges the OTP entry and surfaces 502", async () => {
    process.env.RESEND_API_KEY = "re_test";
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await POST(postReq("alice@example.com"));
    expect(res.status).toBe(502);
    expect(OTP_STORE.has(AUTH_USER_ID)).toBe(false);
  });

  it("on success: stashes the OTP keyed by auth_user_id (with the minted email), sends Resend, sets the pending-email cookie", async () => {
    process.env.RESEND_API_KEY = "re_test";
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const res = await POST(postReq("alice@example.com"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/signup/email-verify?sent=1");
    expect(res.headers.get("set-cookie")).toMatch(
      /_ms_pending_email=alice%40example\.com.*HttpOnly.*SameSite=Lax/,
    );
    const entry = OTP_STORE.get(AUTH_USER_ID);
    expect(entry?.email).toBe("alice@example.com");
    expect(entry?.attempts).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("F-auth-01: carries the brute-force attempts budget across re-mints (a new code does NOT reset attempts)", async () => {
    process.env.RESEND_API_KEY = "re_test";
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    // Simulate 3 prior wrong guesses recorded by the verify route.
    OTP_STORE.set(AUTH_USER_ID, { email: "alice@example.com", code: "000000", expires: Date.now() + 60_000, attempts: 3 });
    await POST(postReq("alice@example.com"));
    expect(OTP_STORE.get(AUTH_USER_ID)?.attempts).toBe(3);
  });

  it("F-auth-01: per-email regeneration cap — the 6th mint of the same email in the window is 429", async () => {
    process.env.RESEND_API_KEY = "re_test";
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    for (let i = 0; i < 5; i++) {
      const ok = await POST(postReq("alice@example.com", `10.0.0.${i}`)); // vary IP so per-IP cap doesn't trip first
      expect(ok.status).toBe(302);
    }
    const sixth = await POST(postReq("alice@example.com", "10.0.0.99"));
    expect(sixth.status).toBe(429);
  });

  it("F-auth-01: per-IP regeneration cap — the 11th mint from the same IP in the window is 429", async () => {
    process.env.RESEND_API_KEY = "re_test";
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    for (let i = 0; i < 10; i++) {
      const ok = await POST(postReq(`user${i}@example.com`, "7.7.7.7")); // vary email so per-email cap doesn't trip first
      expect(ok.status).toBe(302);
    }
    const eleventh = await POST(postReq("user99@example.com", "7.7.7.7"));
    expect(eleventh.status).toBe(429);
  });

  it("always stashes a 6-digit OTP in range (CSPRNG bounds contract)", async () => {
    process.env.RESEND_API_KEY = "re_test";
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    for (let i = 0; i < 100; i++) {
      OTP_STORE.clear();
      _resetRegenForTests(); // avoid tripping the per-IP/email regen caps across iterations
      await POST(postReq(`user${i}@example.com`));
      const code = OTP_STORE.get(AUTH_USER_ID)?.code;
      expect(code).toMatch(/^\d{6}$/);
      const n = Number(code);
      expect(n).toBeGreaterThanOrEqual(100000);
      expect(n).toBeLessThanOrEqual(999999);
    }
  });
});
