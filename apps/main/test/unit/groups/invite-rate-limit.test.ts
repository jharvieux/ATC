// #1654 — the single-invite endpoint has no per-send email throttle (group_invitation
// sends bypass it by design), so without this frequency gate a coordinator could
// rapid-fire invites to unique addresses (a revoke→reinvite spam vector). These
// tests encode WHY the gate matters: it must count recent rows from the shared DB
// store (not a per-instance Map) and must FAIL CLOSED — a count-query error denies,
// never waves the request through.

import { describe, it, expect, vi } from "vitest";
import {
  checkInviteFrequency,
  INVITE_MAX_PER_WINDOW,
} from "@/lib/groups/invite-rate-limit";

function svcReturning(result: { count?: number | null; error?: unknown }) {
  const gte = vi.fn().mockResolvedValue(result);
  const eq = vi.fn().mockReturnValue({ gte });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { svc: { from } as never, gte, eq, select };
}

describe("checkInviteFrequency (#1654)", () => {
  it("allows when recent invites are under the window limit", async () => {
    const { svc } = svcReturning({ count: INVITE_MAX_PER_WINDOW - 1, error: null });
    const res = await checkInviteFrequency(svc, "g-1");
    expect(res.allowed).toBe(true);
  });

  it("denies once the window limit is reached — bounds the burst", async () => {
    const { svc } = svcReturning({ count: INVITE_MAX_PER_WINDOW, error: null });
    const res = await checkInviteFrequency(svc, "g-1");
    expect(res.allowed).toBe(false);
    expect(res.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("fails closed — a count-query error denies rather than allowing", async () => {
    const { svc } = svcReturning({ count: null, error: { message: "db down" } });
    const res = await checkInviteFrequency(svc, "g-1");
    expect(res.allowed).toBe(false);
  });

  it("scopes the count to the group and a recent created_at window", async () => {
    const { svc, eq, gte } = svcReturning({ count: 0, error: null });
    await checkInviteFrequency(svc, "g-42");
    expect(eq).toHaveBeenCalledWith("group_id", "g-42");
    expect(gte).toHaveBeenCalledWith("created_at", expect.any(String));
  });
});
