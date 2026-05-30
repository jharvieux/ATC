// §17.2 — no-email recovery: OTP dispatch (#74).
//
// Contract pinned here: if the OTP can't be MAILED (Resend missing or down)
// the route MUST fail loud and purge the OTP_STORE entry. The earlier shape
// silently no-op'd the Resend call when the key was unset and redirected
// to /signup/email-verify?sent=1 anyway, so any 6-digit guess against the
// stored OTP would have bound the attacker's auth identity to the entered
// email — D-091 Pattern 3 (fail-open).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "@/app/api/auth/microsoft-email-prompt/route";
import { OTP_STORE } from "@/lib/auth/otp-store";

const ORIG_ENV = { ...process.env };
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  OTP_STORE.clear();
  fetchSpy = vi.spyOn(globalThis, "fetch");
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

function postReq(email: string | null): Request {
  const form = new URLSearchParams();
  if (email !== null) form.set("email", email);
  return new Request("https://tenant.example.com/api/auth/microsoft-email-prompt", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

describe("POST /api/auth/microsoft-email-prompt", () => {
  it("rejects a missing/invalid email with 400 and never writes an OTP", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const res = await POST(postReq("not-an-email"));
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

  it("when Resend returns non-OK: purges the OTP entry and surfaces 502 (don't leave a guessable OTP)", async () => {
    process.env.RESEND_API_KEY = "re_test";
    fetchSpy.mockResolvedValue(new Response("rate limited", { status: 429 }));
    const res = await POST(postReq("alice@example.com"));
    expect(res.status).toBe(502);
    expect(OTP_STORE.has("alice@example.com")).toBe(false);
  });

  it("when fetch itself throws (network down): purges the OTP entry and surfaces 502", async () => {
    process.env.RESEND_API_KEY = "re_test";
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await POST(postReq("alice@example.com"));
    expect(res.status).toBe(502);
    expect(OTP_STORE.has("alice@example.com")).toBe(false);
  });

  it("on success: stashes the OTP, sends Resend, redirects with the pending-email cookie", async () => {
    process.env.RESEND_API_KEY = "re_test";
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const res = await POST(postReq("alice@example.com"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/signup/email-verify?sent=1");
    expect(res.headers.get("set-cookie")).toMatch(
      /_ms_pending_email=alice%40example\.com.*HttpOnly.*SameSite=Lax/,
    );
    expect(OTP_STORE.get("alice@example.com")?.attempts).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
