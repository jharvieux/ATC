// #1204 — Behavioral tests for the shared Vercel cron auth gate.
//
// WHY these tests matter: every cron route is publicly reachable. The only
// guard is Authorization: Bearer <CRON_SECRET>. If assertCronAuth fails open
// (returns null on a bad token, or when CRON_SECRET is unset), an attacker can
// trigger scraping runs, reconciliation jobs, and alert floods without auth.
// Fail-closed on a missing env var is the critical case — it must 401, not pass.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function makeReq(authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers["authorization"] = authHeader;
  return new Request("https://example.com/api/cron/test", { headers });
}

describe("assertCronAuth — auth gate", () => {
  it("returns 401 when CRON_SECRET is unset (fail-closed)", async () => {
    delete process.env.CRON_SECRET;
    const { assertCronAuth } = await import("@/lib/cron/assert-cron-auth");
    const res = assertCronAuth(makeReq("Bearer anything"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("returns 401 when Authorization header is absent", async () => {
    process.env.CRON_SECRET = "secret-abc";
    const { assertCronAuth } = await import("@/lib/cron/assert-cron-auth");
    const res = assertCronAuth(makeReq());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("returns 401 when Authorization header has wrong value", async () => {
    process.env.CRON_SECRET = "secret-abc";
    const { assertCronAuth } = await import("@/lib/cron/assert-cron-auth");
    const res = assertCronAuth(makeReq("Bearer wrong-secret"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("returns null (passes) when header exactly matches CRON_SECRET", async () => {
    process.env.CRON_SECRET = "secret-abc";
    const { assertCronAuth } = await import("@/lib/cron/assert-cron-auth");
    const res = assertCronAuth(makeReq("Bearer secret-abc"));
    expect(res).toBeNull();
  });

  it("returns 401 when header is 'Bearer ' with no secret value", async () => {
    process.env.CRON_SECRET = "secret-abc";
    const { assertCronAuth } = await import("@/lib/cron/assert-cron-auth");
    const res = assertCronAuth(makeReq("Bearer "));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });
});
