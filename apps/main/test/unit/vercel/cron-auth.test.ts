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

  // #2047 / D-091 #28 — rotation set. Rotation must be possible with zero cron
  // downtime: _PREVIOUS keeps the old value valid during the overlap window.
  describe("rotation set (#2047)", () => {
    beforeEach(() => {
      delete process.env.CRON_SECRET;
      delete process.env.CRON_SECRET_CURRENT;
      delete process.env.CRON_SECRET_PREVIOUS;
    });

    it("passes with a valid CRON_SECRET_CURRENT (legacy var unset)", async () => {
      process.env.CRON_SECRET_CURRENT = "rotated-current";
      const { assertCronAuth } = await import("@/lib/cron/assert-cron-auth");
      expect(assertCronAuth(makeReq("Bearer rotated-current"))).toBeNull();
    });

    it("passes with a valid CRON_SECRET_PREVIOUS during rotation overlap", async () => {
      process.env.CRON_SECRET_CURRENT = "rotated-current";
      process.env.CRON_SECRET_PREVIOUS = "old-previous";
      const { assertCronAuth } = await import("@/lib/cron/assert-cron-auth");
      expect(assertCronAuth(makeReq("Bearer old-previous"))).toBeNull();
    });

    it("still passes with the legacy CRON_SECRET while the pair also exists", async () => {
      process.env.CRON_SECRET = "vercel-sends-this";
      process.env.CRON_SECRET_CURRENT = "rotated-current";
      const { assertCronAuth } = await import("@/lib/cron/assert-cron-auth");
      expect(assertCronAuth(makeReq("Bearer vercel-sends-this"))).toBeNull();
    });

    it("returns 401 for a token matching no member of the configured set", async () => {
      process.env.CRON_SECRET = "secret-abc";
      process.env.CRON_SECRET_CURRENT = "rotated-current";
      process.env.CRON_SECRET_PREVIOUS = "old-previous";
      const { assertCronAuth } = await import("@/lib/cron/assert-cron-auth");
      const res = assertCronAuth(makeReq("Bearer none-of-those"));
      expect(res).not.toBeNull();
      expect(res!.status).toBe(401);
    });

    it("returns 401 when the entire rotation set is unset (fail-closed)", async () => {
      const { assertCronAuth } = await import("@/lib/cron/assert-cron-auth");
      const res = assertCronAuth(makeReq("Bearer anything"));
      expect(res).not.toBeNull();
      expect(res!.status).toBe(401);
    });
  });
});
